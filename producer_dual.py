import os, json, requests
import pandas as pd
from datetime import datetime, timezone, timedelta
from confluent_kafka import Producer
from entsoe import EntsoePandasClient


# --- Kafka Configuration ---
conf = {
    'bootstrap.servers': os.environ["KAFKA_BOOTSTRAP"],
    'security.protocol': 'SASL_SSL',
    'sasl.mechanism': 'SCRAM-SHA-256',
    'sasl.username': 'avnadmin',
    'sasl.password': os.environ["KAFKA_PASSWORD"],
    # 'ssl.ca.pem': os.environ["KAFKA_CA_PEM"],  <-- Remove this line to avoid permission error
     'ssl.ca.location': 'aiven_ca.pem',   # <--- New line: point to the local CA file
}
producer = Producer(conf)
topic = "energy-prices"

def send_to_kafka(data):
    try:
        producer.produce(topic, json.dumps(data).encode("utf-8"))
        producer.poll(0)
        print(f"Sent: {data}")
    except Exception as e:
        print(f"Kafka send error: {e}")

# --- 1. Elecz Data Fetch ---
def fetch_elecz():
    print("Fetching Elecz data...")
    url = "https://elecz.com/signal/spot?zone=DE"
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        price = data.get("price") or data.get("spot_price")
        if price:
            msg = {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "zone": "DE",
                "price": float(price),
                "source": "elecz"
            }
            send_to_kafka(msg)
        else:
            print("Elecz response format unexpected:", data)
    except Exception as e:
        print(f"Elecz fetch failed: {e}")

# --- 2. ENTSO-E Data Fetch ---
def fetch_entsoe():
    print("Fetching ENTSO-E data...")
    api_key = os.environ.get("ENTSOE_API_KEY")
    if not api_key:
        print("ENTSOE_API_KEY not set, skipping.")
        return

    client = EntsoePandasClient(api_key=api_key)
    
    # 1. Generate native datetime first
    end_dt = datetime.now(timezone.utc)
    start_dt = end_dt - timedelta(hours=2)

    # 2. Force conversion to pd.Timestamp with timezone
    end = pd.Timestamp(end_dt)
    start = pd.Timestamp(start_dt)
    
    # Ensure timezone is not lost (safety check)
    if start.tzinfo is None:
        start = start.tz_localize('UTC')
    if end.tzinfo is None:
        end = end.tz_localize('UTC')

    # 3. Print debug information
    print(f"Debug - start type: {type(start)}, tz: {start.tz}")
    print(f"Debug - end type: {type(end)}, tz: {end.tz}")

    try:
        # Pass the strongly validated timestamp
        prices = client.query_day_ahead_prices("DE_LU", start=start, end=end)
        if not prices.empty:
            latest_ts = prices.index[-1]
            latest_price = prices.iloc[-1]
            msg = {
                "timestamp": str(latest_ts),
                "zone": "DE_LU",
                "price": float(latest_price),
                "source": "entsoe"
            }
            send_to_kafka(msg)
        else:
            print("ENTSO-E returned no data for this period.")
    except Exception as e:
        print(f"ENTSO-E fetch failed: {e}")

# --- Main Execution ---
if __name__ == "__main__":
    fetch_elecz()
    fetch_entsoe()
    producer.flush()
    print("All data sent.")