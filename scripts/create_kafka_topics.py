#!/usr/bin/env python3
"""Create Kafka topics required by the VoltScope pipeline.

Uses the same Aiven Kafka credentials (SASL_SSL, SCRAM-SHA-256) as the
producers and Databricks ingest notebooks.

Topics: crypto-market, energy-prices
"""
from __future__ import annotations

import os
import sys

from confluent_kafka.admin import AdminClient, NewTopic

BOOTSTRAP = os.environ.get("KAFKA_BOOTSTRAP")
USERNAME = os.environ.get("KAFKA_USERNAME", "avnadmin")
PASSWORD = os.environ.get("KAFKA_PASSWORD")
CA_LOCATION = os.environ.get("KAFKA_CA_LOCATION", "aiven_ca.pem")

TOPICS = [
    NewTopic("crypto-market", num_partitions=1, replication_factor=1),
    NewTopic("energy-prices", num_partitions=1, replication_factor=1),
]


def main() -> int:
    missing = [n for n, v in (("KAFKA_BOOTSTRAP", BOOTSTRAP), ("KAFKA_PASSWORD", PASSWORD)) if not v]
    if missing:
        print(f"error: missing required env: {', '.join(missing)}")
        return 2

    conf = {
        "bootstrap.servers": BOOTSTRAP,
        "security.protocol": "SASL_SSL",
        "sasl.mechanism": "SCRAM-SHA-256",
        "sasl.username": USERNAME,
        "sasl.password": PASSWORD,
        "ssl.ca.location": CA_LOCATION,
    }

    admin = AdminClient(conf)
    fs = admin.create_topics(TOPICS, request_timeout=30.0)

    for topic, f in fs.items():
        try:
            f.result()
            print(f"topic '{topic}' created (or already exists)")
        except Exception as exc:
            if "TOPIC_ALREADY_EXISTS" in str(exc):
                print(f"topic '{topic}' already exists")
            else:
                print(f"error creating topic '{topic}': {exc}")
                return 1

    # Verify metadata
    md = admin.list_topics(timeout=30.0)
    for t in TOPICS:
        if t.topic in md.topics:
            print(f"verified: '{t.topic}' present in cluster metadata")
        else:
            print(f"warning: '{t.topic}' not found in cluster metadata after creation")
            return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
