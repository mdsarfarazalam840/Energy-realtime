import os, json, requests
from datetime import datetime, timezone
from confluent_kafka import Producer

# 1. Fetch data from Elecz (No API key needed)
url = "https://elecz.com/signal/spot?zone=DE"
try:
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    data = resp.json()
except Exception as e:
    print(f"Failed to fetch Elecz data: {e}")
    raise SystemExit(1)

# 2. Extract the price (Elecz returns JSON; we look for the price field)
# If Elecz changes their format, you adjust this line.
price = data.get("price") or data.get("spot_price")
if price is None:
    print("Unexpected response format:", data)
    raise SystemExit(1)

# 3. Format the message
msg = {
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "zone": "DE",
    "price": float(price),
    "source": "elecz"
}

# 4. Connect to Aiven Kafka using GitHub Secrets
conf = {
    'bootstrap.servers': os.environ["KAFKA_BOOTSTRAP"],
    'security.protocol': 'SASL_SSL',
    'sasl.mechanism': 'SCRAM-SHA-256',
    'sasl.username': 'avnadmin',
    'sasl.password': os.environ["KAFKA_PASSWORD"],
    'ssl.ca.pem': os.environ["KAFKA_CA_PEM"],
}

producer = Producer(conf)
producer.produce("energy-prices", json.dumps(msg).encode("utf-8"))
producer.flush()
print("Successfully sent to Kafka:", msg)