#!/usr/bin/env python3
"""Validate the generated data.js bundle against the official invariants."""

from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = (ROOT / "data.js").read_text(encoding="utf-8")
DATA = json.loads(re.sub(r"^window\.VRS_DATA = ", "", RAW).rstrip().rstrip(";"))

teams = DATA["teams"]
latest = DATA["latestDate"]
snapshot = DATA["snapshots"][latest]

print(f"Latest snapshot: {latest}")
print(f"Teams in standings: {len(snapshot['standings'])}")
print(f"Teams with details: {len(teams)}")
print(f"Failures: {len(DATA['failures'])}")

regions = Counter(team["region"] or "Unknown" for team in snapshot["standings"])
print(f"Regions: {dict(regions)}")

missing_region = [t["name"] for t in snapshot["standings"] if not t["region"]]
if missing_region:
    print(f"! {len(missing_region)} teams without region, e.g. {missing_region[:5]}")

# 1. final = starting + h2h
bad_equation = []
for team in teams.values():
    delta = abs(team["finalRankValue"] - (team["startingRankValue"] + team["h2hAdjustment"]))
    if delta > 0.15:
        bad_equation.append((team["name"], team["finalRankValue"], team["startingRankValue"], team["h2hAdjustment"], delta))

# 2. average = mean(four factors)
bad_average = []
for team in teams.values():
    f = team["factors"]
    mean = sum(f[k] for k in ("bountyOffered", "bountyCollected", "opponentNetwork", "lanWins")) / 4
    if abs(mean - f["average"]) > 0.002:
        bad_average.append((team["name"], f["average"], mean))

# 3. points == round(final); the detail page rounds to 1 decimal, so allow 0.5
bad_points = []
for team in teams.values():
    if abs(team["points"] - team["finalRankValue"]) > 0.5:
        bad_points.append((team["name"], team["points"], team["finalRankValue"]))

print(f"\nfinal == starting + h2h : {len(teams) - len(bad_equation)}/{len(teams)}")
for row in bad_equation[:5]:
    print("   ", row)

print(f"average == mean(factors): {len(teams) - len(bad_average)}/{len(teams)}")
for row in bad_average[:5]:
    print("   ", row)

print(f"points == round(final)  : {len(teams) - len(bad_points)}/{len(teams)}")
for row in bad_points[:5]:
    print("   ", row)

# 4. sanity on parsed structures
no_matches = [t["name"] for t in teams.values() if not t["matches"]]
no_winnings = [t["name"] for t in teams.values() if not t["winnings"]]
short_roster = [t["name"] for t in teams.values() if len(t["roster"]) != 5]
zero_points = [t["name"] for t in teams.values() if t["points"] == 0]

print(f"\nTeams with zero matches: {len(no_matches)}")
print(f"Teams with zero winnings: {len(no_winnings)}")
print(f"Teams without exactly 5 players: {len(short_roster)}")
print(f"Teams with 0 points: {len(zero_points)}")

total_matches = sum(len(t["matches"]) for t in teams.values())
print(f"Total match rows: {total_matches}")

# 5. duplicates by roster key
keys = Counter("|".join(sorted(p.strip().lower() for p in t["roster"])) for t in teams.values())
dupes = [k for k, n in keys.items() if n > 1]
print(f"Duplicate roster keys: {len(dupes)}")

# 6. duplicate names
names = Counter(t["name"] for t in teams.values())
print(f"Duplicate team names: {[n for n, c in names.items() if c > 1]}")

# 7. history coverage
history_len = {}
for date in DATA["dates"]:
    for row in DATA["snapshots"][date]["standings"]:
        history_len[row["id"]] = history_len.get(row["id"], 0) + 1
hist_len = Counter(history_len.get(team_id, 0) for team_id in teams)
print(f"History length distribution: {dict(sorted(hist_len.items()))}")

top = sorted(teams.values(), key=lambda t: t["globalRank"])[:5]
print("\nTop 5:")
for t in top:
    print(f"  #{t['globalRank']:>3} {t['name'][:22]:<22} pts={t['points']:<5} start={t['startingRankValue']:<8} h2h={t['h2hAdjustment']:<7} matches={len(t['matches'])}")

# 8. structural anomalies
anomalies = []
for team in teams.values():
    for key, value in team["factors"].items():
        if key == "average":
            continue
        if value < 0 or value > 1.0001:
            anomalies.append((team["name"], "factor out of range", key, value))
    for match in team["matches"]:
        if match["result"] not in {"W", "L"}:
            anomalies.append((team["name"], "bad result", match["result"]))
        if not match["roster"]:
            anomalies.append((team["name"], "empty match roster", match["matchPlayed"]))
    if not team["roster"]:
        anomalies.append((team["name"], "empty roster", None))
    if not team["name"]:
        anomalies.append((team["name"], "empty name", None))

print(f"\nStructural anomalies: {len(anomalies)}")
for row in anomalies[:10]:
    print("   ", row)

