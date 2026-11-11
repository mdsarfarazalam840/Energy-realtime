"""Unit tests for the flights snapshot producer (no Kafka required)."""

import producer_flights as pf

SNAPSHOT = {
    "schema_version": 1,
    "source": "adsb.lol",
    "fetched_at": "2026-11-11T04:21:20.008Z",
    "planes": [
        {
            "icao24": "C8281B",
            "callsign": " PLC2 ",
            "country": "New Zealand",
            "lat": -36.9021,
            "lon": 174.7107,
            "lastUpdateMs": 1794370879487,
            "lastUpdate": "2026-11-11T04:21:19Z",
        },
        {
            "icao24": "c8281b",
            "callsign": "PLC2",
            "country": "New Zealand",
            "lat": -36.9021,
            "lon": 174.7107,
            "lastUpdateMs": 1794370879000,
            "lastUpdate": "2026-11-11T04:21:18Z",
        },
        {"icao24": "not-hex", "lat": 1.0, "lon": 2.0},
        {"icao24": "abcdef", "lat": 200.0, "lon": 2.0},
        {"icao24": "123456", "lat": None, "lon": 2.0},
    ],
}


def test_normalize_plane_keeps_contract_fields():
    message = pf.normalize_plane(SNAPSHOT["planes"][0], SNAPSHOT)
    assert message is not None
    assert message["icao24"] == "c8281b"
    assert message["callsign"] == "PLC2"
    assert message["timestamp"] == "2026-11-11T04:21:19Z"
    assert message["snapshot_id"] == "2026-11-11T04:21:20Z"
    assert message["lat"] == -36.9021
    assert message["lon"] == 174.7107
    assert message["last_update_ms"] == 1794370879487
    assert message["source"] == "adsb.lol"


def test_normalize_plane_rejects_invalid_rows():
    assert pf.normalize_plane({"icao24": "zzzzzz", "lat": 1, "lon": 2}, SNAPSHOT) is None
    assert pf.normalize_plane({"icao24": "abcdef", "lat": 91, "lon": 2}, SNAPSHOT) is None
    assert pf.normalize_plane({"icao24": "abcdef", "lat": 1, "lon": None}, SNAPSHOT) is None
    assert pf.normalize_plane("not a plane", SNAPSHOT) is None


def test_build_messages_deduplicates_and_sorts_by_icao():
    messages = pf.build_messages(SNAPSHOT)
    assert [message["icao24"] for message in messages] == ["c8281b"]
    # The newest observation wins the duplicate.
    assert messages[0]["last_update_ms"] == 1794370879487


def test_build_messages_requires_planes_array():
    try:
        pf.build_messages({"fetched_at": "2026-11-11T00:00:00Z"})
    except TypeError as exc:
        assert "planes" in str(exc)
    else:
        raise AssertionError("expected TypeError for a snapshot without planes")
