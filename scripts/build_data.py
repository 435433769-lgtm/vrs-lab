#!/usr/bin/env python3
"""Build a static data bundle for the VRS prototype.

Data source: https://github.com/ValveSoftware/counter-strike_regional_standings
The prototype only reads publicly published standings/details. It does not
recompute VRS and is not affiliated with Valve.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data" / "raw"
LOCAL_REPO = CACHE / "repo" / "counter-strike_regional_standings-main"
OUT = ROOT / "data.js"
META = ROOT / "data" / "meta.json"
BASE = "https://cdn.jsdelivr.net/gh/ValveSoftware/counter-strike_regional_standings@main/"
API = "https://api.github.com/repos/ValveSoftware/counter-strike_regional_standings/contents/live/"
HEADERS = {"User-Agent": "vrs-prototype/0.1"}

REGIONS = {
    "europe": "Europe",
    "americas": "Americas",
    "asia": "Asia",
}


def atomic_write(path: Path, text: str) -> None:
    """Write text to a temp file in the same directory, then swap it in.

    Readers either see the previous complete file or the new complete file,
    never a partially written bundle while a rebuild is running.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp"
    )
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def fetch(path: str) -> str:
    """Read a file from the local repo snapshot, then the on-disk cache, then the CDN."""
    for candidate in (LOCAL_REPO / path, CACHE / path):
        if candidate.is_file():
            return candidate.read_text(encoding="utf-8")

    last_error: Exception | None = None
    for attempt in range(5):
        try:
            req = urllib.request.Request(BASE + path, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as response:
                text = response.read().decode("utf-8")
            break
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise
            last_error = exc
            time.sleep(1 + attempt * 2)
        except Exception as exc:  # noqa: BLE001 - network is flaky in this environment
            last_error = exc
            time.sleep(1 + attempt * 2)
    else:
        raise RuntimeError(f"Could not fetch {path}: {last_error}")

    cached = CACHE / path
    cached.parent.mkdir(parents=True, exist_ok=True)
    cached.write_text(text, encoding="utf-8")
    return text


def list_snapshot_dates(year: str) -> list[str]:
    local = LOCAL_REPO / "live" / year
    if local.is_dir():
        names = [entry.name for entry in local.iterdir()]
    else:
        req = urllib.request.Request(API + year, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as response:
            names = [entry["name"] for entry in json.load(response)]

    dates = []
    for name in names:
        match = re.fullmatch(r"standings_global_(\d{4}_\d{2}_\d{2})\.md", name)
        if match:
            dates.append(match.group(1).replace("_", "-"))
    return sorted(dates)


def list_years() -> list[str]:
    """Discover the year folders that hold snapshots, so new years keep working."""
    local = LOCAL_REPO / "live"
    if local.is_dir():
        names = [entry.name for entry in local.iterdir() if entry.is_dir()]
    else:
        req = urllib.request.Request(API, headers=HEADERS)
        with urllib.request.urlopen(req, timeout=60) as response:
            names = [entry["name"] for entry in json.load(response) if entry.get("type") == "dir"]

    years = sorted(name for name in names if re.fullmatch(r"\d{4}", name))
    return years or ["2025", str(datetime.now(timezone.utc).year)]


def clean(value: str) -> str:
    """Strip trailing markdown line-break markers and stray HTML from a cell."""
    value = re.sub(r"<br\s*/?>", "", value)
    return re.sub(r"\s+", " ", value).strip()


def split_roster(value: str) -> list[str]:
    return [clean(part) for part in value.split(",") if clean(part)]


def normalize_nick(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def roster_key(players: list[str]) -> str:
    return "|".join(sorted(normalize_nick(player) for player in players))


def roster_id(players: list[str]) -> str:
    digest = hashlib.sha1(roster_key(players).encode("utf-8")).hexdigest()
    return "r" + digest[:12]


def to_float(value: str) -> float | None:
    value = value.strip().replace(",", "")
    if value in {"", "-", "—"}:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def parse_money(value: str) -> float | None:
    match = re.search(r"\$?\s*([\d,]+(?:\.\d+)?)", value)
    if not match:
        return None
    return float(match.group(1).replace(",", ""))


def parse_standings(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        if not line.startswith("|") or "[details]" not in line:
            continue

        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 5:
            continue

        link = re.search(r"\[details\]\(([^)]+)\)", cells[4])
        if not link:
            continue

        try:
            rank = int(cells[0])
            points = int(cells[1])
        except ValueError:
            continue

        roster = split_roster(cells[3])
        rows.append(
            {
                "rank": rank,
                "points": points,
                "name": clean(cells[2]),
                "roster": roster,
                "id": roster_id(roster),
                "detailPath": link.group(1),
            }
        )
    return rows


def parse_detail(text: str, fallback: dict) -> dict:
    def first(pattern: str, default: str = "") -> str:
        match = re.search(pattern, text)
        return clean(match.group(1)) if match else default

    name = first(r"Team Name:\s*(.+)", fallback["name"])
    roster = split_roster(first(r"Roster:\s*(.+)", ", ".join(fallback["roster"])))
    region = first(r"Region:\s*\[([^\]]+)\]", "")
    global_rank = int(
        first(r"Global Rank:\s*\[(\d+)\]", str(fallback.get("rank") or fallback.get("globalRank") or 0))
    )
    regional_rank = int(first(r"Regional Rank:\s*\[(\d+)\]", "0"))

    final_value = to_float(first(r"Final Rank Value:\s*([\d.]+)"))
    equation = re.search(
        r"Final Rank Value \(([\d.]+)\) = Starting Rank Value \(([\d.]+)\) "
        r"\+ Head To Head Adjustments \((-?[\d.]+)\)",
        text,
    )
    if equation:
        final_value = float(equation.group(1))
        starting_value = float(equation.group(2))
        h2h_adjustment = float(equation.group(3))
    else:
        starting_value = final_value or 0.0
        h2h_adjustment = 0.0

    factor_labels = {
        "bountyOffered": "Bounty Offered",
        "bountyCollected": "Bounty Collected",
        "opponentNetwork": "Opponent Network",
        "lanWins": "LAN Wins",
    }
    factors = {}
    for key, label in factor_labels.items():
        factors[key] = to_float(first(rf"- {re.escape(label)}:\s*([\d.]+)")) or 0.0

    factors["average"] = to_float(first(r"The average of these factors is ([\d.]+)")) or 0.0

    min_average = None
    max_average = None
    scale = re.search(
        r"400 \+ \( \( ([\d.]+) - ([\d.]+) \) / \( ([\d.]+) - ([\d.]+) \) \) \* 1600",
        text,
    )
    if scale:
        min_average = float(scale.group(2))
        max_average = float(scale.group(3))

    top10 = None
    reference = None
    bounty_line = re.search(
        r"sum of their top 10 scaled winnings \(\$([\d,]+(?:\.\d+)?)\)", text
    )
    if bounty_line:
        top10 = float(bounty_line.group(1).replace(",", ""))

    reference_line = re.search(
        r"5th highest value among all rosters \(\$([\d,]+(?:\.\d+)?)\)", text
    )
    if reference_line:
        reference = float(reference_line.group(1).replace(",", ""))

    matches = []
    match_header = None
    for index, line in enumerate(text.splitlines()):
        if "Match Played" in line and "H2H Adj." in line:
            match_header = index
            break

    if match_header is not None:
        for line in text.splitlines()[match_header + 1 :]:
            if not line.startswith("|"):
                if matches:
                    break
                continue
            if re.fullmatch(r"\|[\s:|-]+\|?", line.strip()):
                continue

            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) < 12:
                continue
            if not re.fullmatch(r"\d+", cells[0]):
                continue

            bounty = re.search(r"([\d.]+)\s*\(([\d.]+)\)", cells[7])
            network = re.search(r"([\d.]+)\s*\(([\d.]+)\)", cells[8])
            lan = re.search(r"(\d)\s*\(([\d.]+)\)", cells[9])

            matches.append(
                {
                    "matchPlayed": int(cells[0]),
                    "matchId": int(cells[1]) if cells[1].isdigit() else None,
                    "date": cells[2],
                    "opponent": clean(cells[3]),
                    "result": cells[4],
                    "ageWeight": to_float(cells[5]),
                    "eventWeight": to_float(cells[6]),
                    "bountyRaw": float(bounty.group(1)) if bounty else None,
                    "bountyAdjusted": float(bounty.group(2)) if bounty else None,
                    "networkRaw": float(network.group(1)) if network else None,
                    "networkAdjusted": float(network.group(2)) if network else None,
                    "lanWin": (lan.group(1) == "1") if lan else None,
                    "lanAdjusted": float(lan.group(2)) if lan else None,
                    "h2h": to_float(cells[10]) or 0.0,
                    "roster": split_roster(cells[11]),
                }
            )

    winnings = []
    winnings_header = None
    for index, line in enumerate(text.splitlines()):
        if "Event Date" in line and "Scaled Winnings" in line:
            winnings_header = index
            break

    if winnings_header is not None:
        for line in text.splitlines()[winnings_header + 1 :]:
            if not line.startswith("|"):
                if winnings:
                    break
                continue
            if re.fullmatch(r"\|[\s:|-]+\|?", line.strip()):
                continue

            cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
            if len(cells) < 4 or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", cells[0]):
                continue

            prize = parse_money(cells[2])
            scaled = parse_money(cells[3])
            if prize is None or scaled is None:
                continue

            winnings.append(
                {
                    "date": cells[0],
                    "ageWeight": to_float(cells[1]) or 0.0,
                    "prize": prize,
                    "scaled": scaled,
                }
            )

    return {
        "name": name,
        "roster": roster,
        "region": region or fallback.get("region", ""),
        "globalRank": global_rank,
        "regionalRank": regional_rank,
        "points": fallback["points"],
        "finalRankValue": final_value or 0.0,
        "startingRankValue": starting_value,
        "h2hAdjustment": h2h_adjustment,
        "factors": factors,
        "top10ScaledWinnings": top10,
        "referenceWinnings5th": reference,
        "minAverage": min_average,
        "maxAverage": max_average,
        "matches": matches,
        "winnings": winnings,
    }


def load_qualification() -> dict | None:
    """Read the Major invite allocation overlay, if it is present."""
    path = ROOT / "data" / "qualification.json"
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"! qualification.json is not valid JSON: {exc}")
        return None


def main() -> None:
    years = list_years()
    dates_by_year = {year: list_snapshot_dates(year) for year in years}
    all_dates = sorted(date for dates in dates_by_year.values() for date in dates)
    if not all_dates:
        raise RuntimeError("No snapshots found in the official repository.")
    print(f"Snapshots: {len(all_dates)} ({all_dates[0]} .. {all_dates[-1]})")

    snapshots: dict[str, dict] = {}
    current_rows: list[dict] = []

    for date in all_dates:
        year = date[:4]
        ymd = date.replace("-", "_")

        regional_meta: dict[str, tuple[str, int]] = {}
        for file_region, region_name in REGIONS.items():
            path = f"live/{year}/standings_{file_region}_{ymd}.md"
            try:
                text = fetch(path)
            except Exception:  # noqa: BLE001 - some regions are not published for every date
                continue
            for row in parse_standings(text):
                regional_meta[row["detailPath"]] = (region_name, row["rank"])

        global_path = f"live/{year}/standings_global_{ymd}.md"
        rows = parse_standings(fetch(global_path))

        standings = []
        for row in rows:
            region, regional_rank = regional_meta.get(row["detailPath"], ("", 0))
            entry = {
                "id": row["id"],
                "name": row["name"],
                "roster": row["roster"],
                "region": region,
                "globalRank": row["rank"],
                "regionalRank": regional_rank,
                "points": row["points"],
                "detailPath": row["detailPath"],
            }
            standings.append(entry)
            if date == all_dates[-1]:
                current_rows.append(entry)

        snapshots[date] = {"date": date, "standings": standings}
        print(f"  {date}: {len(standings)} teams")

    # Current snapshot: download and parse every detail file.
    latest = all_dates[-1]
    latest_year = latest[:4]
    print(f"Parsing details for {latest} ({len(current_rows)} files)...")

    teams: dict[str, dict] = {}
    failures: list[str] = []

    def load_current(row: dict) -> tuple[dict, dict] | None:
        path = f"live/{latest_year}/{row['detailPath']}"
        try:
            text = fetch(path)
            detail = parse_detail(text, row)
        except Exception as exc:  # noqa: BLE001 - prototype should keep going
            print(f"    ! {row['detailPath']}: {type(exc).__name__}: {exc}")
            return None
        return row, detail

    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(load_current, row): row for row in current_rows}
        for future in as_completed(futures):
            row = futures[future]
            result = future.result()
            if result is None:
                failures.append(row["detailPath"])
                continue

            row, detail = result
            team_id = row["id"]
            detail["id"] = team_id
            detail["detailPath"] = f"live/{latest_year}/{row['detailPath']}"
            detail["points"] = row["points"]
            teams[team_id] = detail

    # Snapshot-level min/max factor averages.
    averages = [team["factors"]["average"] for team in teams.values()]
    min_average = min(averages) if averages else 0.0
    max_average = max(averages) if averages else 1.0
    for snapshot in snapshots.values():
        snapshot["minAverage"] = round(min_average, 4)
        snapshot["maxAverage"] = round(max_average, 4)
        snapshot["teamCount"] = len(snapshot["standings"])

    built_at = (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

    payload = {
        "generatedAt": latest,
        "builtAt": built_at,
        "latestDate": latest,
        "dates": all_dates,
        "snapshots": snapshots,
        "teams": teams,
        "failures": failures,
        "qualification": load_qualification(),
        "source": {
            "repo": "https://github.com/ValveSoftware/counter-strike_regional_standings",
            "eventData": "HLTV.org",
        },
    }

    bundle = (
        "window.VRS_DATA = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    atomic_write(OUT, bundle)

    meta = {
        "latestDate": latest,
        "builtAt": built_at,
        "teamCount": len(teams),
        "snapshotCount": len(all_dates),
        "dataBytes": len(bundle.encode("utf-8")),
        "source": payload["source"]["repo"],
    }
    atomic_write(META, json.dumps(meta, ensure_ascii=False, indent=2) + "\n")

    size_mb = OUT.stat().st_size / (1024 * 1024)
    print(f"Wrote {OUT} ({size_mb:.2f} MB)")
    print(f"Teams with details: {len(teams)} / {len(current_rows)}")
    if failures:
        print(f"Detail failures: {len(failures)}")
        for path in failures[:5]:
            print(f"  - {path}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
