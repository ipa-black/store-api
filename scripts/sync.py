from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit
from urllib.request import Request, urlopen
import hashlib
import json
import os
import re
import sys
import tempfile
import time


UPSTREAM = "drphe/KhoIPA"
UPSTREAM_BRANCH = "main"

SOURCE_NAME = "IPA BLACK"
SOURCE_ID = "com.ipablack.khoipa.feather.v1"
SOURCE_ICON = "https://github.com/ipa-black.png"

TEST_BUNDLES = {
    "games.needspeed",
    "games.sand-loop-relaxing-tap-game",
    "games.lucky-pirates-ahoy",
    "games.puzzle-and-dragons",
    "games.axis-blade",
}


def text(value):
    return value.strip() if isinstance(value, str) else ""


def clean_url(value):
    try:
        value = text(value)

        if not value:
            return None

        if any(
            ord(char) < 32 or ord(char) == 127
            for char in value
        ):
            return None

        parsed = urlsplit(value)

        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username
            or parsed.password
        ):
            return None

        host = (
            parsed.hostname
            .encode("idna")
            .decode("ascii")
            .lower()
        )

        if ":" in host:
            host = "[" + host + "]"

        if parsed.port:
            host += ":" + str(parsed.port)

        path = "/".join(
            quote(unquote(part, errors="strict"), safe="")
            for part in parsed.path.split("/")
        )

        query = re.sub(
            r"%(?![0-9a-fA-F]{2})",
            "%25",
            parsed.query,
        )

        query = quote(
            query,
            safe="%&=+;,:/?@!$'()*-._~",
        )

        return urlunsplit(
            (parsed.scheme, host, path, query, "")
        )

    except (ValueError, UnicodeError):
        return None


def clean_date(value):
    value = text(value)

    if not value:
        return None

    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            result = datetime.strptime(
                value,
                "%Y-%m-%d",
            ).replace(tzinfo=timezone.utc)

        else:
            result = datetime.fromisoformat(
                value.replace("Z", "+00:00")
            )

            if result.tzinfo is None:
                result = result.replace(
                    tzinfo=timezone.utc
                )

        return result.astimezone(timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        )

    except ValueError:
        return None


def fetch_json(url):
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "IPA-BLACK-Sync/1.0",
    }

    token = os.environ.get("GITHUB_TOKEN")

    if (
        token
        and urlsplit(url).hostname == "api.github.com"
    ):
        headers["Authorization"] = "Bearer " + token

    max_bytes = 100 * 1024 * 1024

    for attempt in range(3):
        try:
            request = Request(url, headers=headers)

            with urlopen(
                request,
                timeout=45,
            ) as response:
                raw = response.read(max_bytes + 1)

            if len(raw) > max_bytes:
                raise ValueError(
                    "Upstream response is too large"
                )

            return (
                json.loads(raw),
                hashlib.sha256(raw).hexdigest(),
            )

        except Exception:
            if attempt == 2:
                raise

            time.sleep(2 ** attempt)


def discover_catalogs():
    url = (
        f"https://api.github.com/repos/{UPSTREAM}"
        f"/contents/upload?ref={UPSTREAM_BRANCH}"
    )

    listing, _ = fetch_json(url)

    if not isinstance(listing, list):
        raise ValueError(
            "Cannot read upstream catalog directory"
        )

    names = set()

    for item in listing:
        if item.get("type") != "file":
            continue

        match = re.fullmatch(
            r"repo\.([a-zA-Z0-9_-]+)\.json",
            item.get("name", ""),
        )

        if match:
            names.add(match.group(1))

    if not names:
        raise ValueError("No catalogs found")

    return sorted(names)


def load_catalog(name):
    url = (
        f"https://raw.githubusercontent.com/{UPSTREAM}"
        f"/{UPSTREAM_BRANCH}/upload/repo.{name}.json"
    )

    data, digest = fetch_json(url)

    if (
        not isinstance(data, dict)
        or not isinstance(data.get("apps"), list)
        or not data["apps"]
    ):
        raise ValueError(
            f"{name}: invalid or empty catalog"
        )

    return name, data, digest


def normalize_app(row, source, index):
    if not isinstance(row, dict):
        raise ValueError(
            f"{source}[{index}]: invalid app"
        )

    versions = row.get("versions")

    latest = (
        versions[0]
        if isinstance(versions, list)
        and versions
        and isinstance(versions[0], dict)
        else {}
    )

    bundle = (
        text(row.get("bundleIdentifier"))
        or text(row.get("bundleID"))
    )

    version = (
        text(row.get("version"))
        or text(latest.get("version"))
    )

    download = clean_url(
        row.get("downloadURL")
        or row.get("down")
        or latest.get("downloadURL")
    )

    if not bundle or not version or not download:
        raise ValueError(
            f"{source}[{index}]: "
            "missing bundle, version or download URL"
        )

    app = {
        "name": text(row.get("name")) or bundle,
        "bundleIdentifier": bundle,
        "developerName": (
            text(row.get("developerName"))
            or "Unknown"
        ),
        "iconURL": (
            clean_url(
                row.get("iconURL")
                or row.get("icon")
            )
            or SOURCE_ICON
        ),
        "version": version,
        "downloadURL": download,
    }

    size = row.get("size", latest.get("size"))

    if isinstance(size, str) and size.isdigit():
        size = int(size)

    if (
        type(size) is int
        and 0 <= size <= 2**53 - 1
    ):
        app["size"] = size

    date = clean_date(
        row.get("versionDate")
        or latest.get("date")
    )

    if date:
        app["versionDate"] = date

    return {
        "source": source,
        "app": app,
    }


def merge_apps(records):
    groups = {}

    for record in records:
        bundle = record["app"]["bundleIdentifier"]
        groups.setdefault(bundle, []).append(record)

    result = []

    for bundle in sorted(groups, key=str.casefold):
        rows = sorted(
            groups[bundle],
            key=lambda item: (
                item["app"].get("versionDate", ""),
                item["app"]["version"],
                item["source"],
                item["app"]["downloadURL"],
            ),
            reverse=True,
        )

        app = dict(rows[0]["app"])
        builds = {}

        for record in rows:
            current = record["app"]

            key = (
                current["version"],
                current["downloadURL"],
            )

            if key not in builds:
                build = {
                    "version": current["version"],
                    "downloadURL": current["downloadURL"],
                    "buildVersion": hashlib.sha256(
                        json.dumps(key).encode()
                    ).hexdigest()[:16],
                }

                if "versionDate" in current:
                    build["date"] = current["versionDate"]

                if "size" in current:
                    build["size"] = current["size"]

                builds[key] = {
                    "build": build,
                    "labels": set(),
                }

            builds[key]["labels"].add(
                current["name"] + " | " + record["source"]
            )

        app["versions"] = []

        for entry in builds.values():
            entry["build"]["localizedDescription"] = (
                "; ".join(sorted(entry["labels"]))
            )
            app["versions"].append(entry["build"])

        app["localizedDescription"] = (
            "Sources: "
            + ", ".join(
                sorted({
                    record["source"]
                    for record in rows
                })
            )
        )

        result.append(app)

    return result


def make_source(apps, suffix, name, base_url, path):
    identifier = (
        SOURCE_ID
        if suffix == "all"
        else SOURCE_ID + "." + suffix
    )

    source = {
        "name": name,
        "identifier": identifier,
        "iconURL": SOURCE_ICON,
        "apps": apps,
        "news": [],
    }

    if base_url:
        source["sourceURL"] = base_url + "/" + path

    return source


def validate_source(source):
    apps = source["apps"]

    if not apps:
        raise ValueError("Generated source is empty")

    identifiers = {
        app["bundleIdentifier"]
        for app in apps
    }

    if len(identifiers) != len(apps):
        raise ValueError("Duplicate app identifiers")

    required_fields = (
        "name",
        "bundleIdentifier",
        "version",
        "developerName",
        "iconURL",
        "downloadURL",
    )

    for app in apps:
        for field in required_fields:
            if (
                not isinstance(app.get(field), str)
                or not app[field]
            ):
                raise ValueError(
                    "Invalid field: " + field
                )

        urls = [
            app["iconURL"],
            app["downloadURL"],
            *[
                build["downloadURL"]
                for build in app["versions"]
            ],
        ]

        for url in urls:
            invalid_chars = any(
                ord(char) <= 32
                or ord(char) in {
                    34, 60, 62, 91, 92, 93, 94,
                    96, 123, 124, 125, 127,
                }
                for char in url
            )

            if clean_url(url) != url or invalid_chars:
                raise ValueError(
                    "Invalid encoded URL: " + url
                )

        version_ids = {
            (
                build["version"],
                build["buildVersion"],
            )
            for build in app["versions"]
        }

        if len(version_ids) != len(app["versions"]):
            raise ValueError(
                "Duplicate version identifiers"
            )

        if (
            app["versions"][0]["downloadURL"]
            != app["downloadURL"]
        ):
            raise ValueError(
                "Latest download URL mismatch"
            )


def generate(catalogs, base_url):
    outputs = {}
    records = []
    catalog_info = {}

    for name, data, digest in sorted(catalogs):
        current = [
            normalize_app(row, name, index)
            for index, row in enumerate(data["apps"])
        ]

        records.extend(current)
        apps = merge_apps(current)

        filename = "sources/" + name + ".json"

        source = make_source(
            apps=apps,
            suffix=name,
            name=(
                SOURCE_NAME
                + " - "
                + (text(data.get("name")) or name)
            ),
            base_url=base_url,
            path=filename,
        )

        validate_source(source)
        outputs[filename] = source

        catalog_info[name] = {
            "inputRecords": len(current),
            "apps": len(apps),
            "sha256": digest,
            "file": filename,
        }

    apps = merge_apps(records)

    combined_source = make_source(
        apps=apps,
        suffix="all",
        name=SOURCE_NAME,
        base_url=base_url,
        path="repo.json",
    )

    validate_source(combined_source)

    expected = {
        (
            record["app"]["bundleIdentifier"],
            record["app"]["version"],
            record["app"]["downloadURL"],
        )
        for record in records
    }

    actual = {
        (
            app["bundleIdentifier"],
            build["version"],
            build["downloadURL"],
        )
        for app in apps
        for build in app["versions"]
    }

    if expected != actual:
        raise ValueError(
            "Some app builds were lost during merge"
        )

    outputs["repo.json"] = combined_source

    test_apps = [
        app
        for app in apps
        if app["bundleIdentifier"] in TEST_BUNDLES
    ] or apps[:5]

    test_source = make_source(
        apps=test_apps,
        suffix="test",
        name=SOURCE_NAME + " - Test",
        base_url=base_url,
        path="repo-test.json",
    )

    validate_source(test_source)
    outputs["repo-test.json"] = test_source

    outputs["status.json"] = {
        "name": SOURCE_NAME,
        "upstream": UPSTREAM,
        "catalogs": catalog_info,
        "inputRecords": len(records),
        "apps": len(apps),
        "currentBuilds": len(actual),
        "testApps": len(test_apps),
    }

    return outputs


def save_outputs(outputs):
    root = Path("public")
    root.mkdir(parents=True, exist_ok=True)

    status_path = root / "status.json"

    old_status = (
        json.loads(
            status_path.read_text(encoding="utf-8")
        )
        if status_path.exists()
        else {}
    )

    old_date = old_status.pop("checkedAt", None)

    if (
        old_status == outputs["status.json"]
        and old_date
    ):
        outputs["status.json"]["checkedAt"] = old_date
    else:
        outputs["status.json"]["checkedAt"] = (
            datetime.now(timezone.utc).strftime(
                "%Y-%m-%dT%H:%M:%SZ"
            )
        )

    for filename, data in outputs.items():
        target = root / filename
        target.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        content = (
            json.dumps(
                data,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            + "\n"
        ).encode("utf-8")

        if (
            target.exists()
            and target.read_bytes() == content
        ):
            continue

        descriptor, temporary = tempfile.mkstemp(
            prefix=".ipa-black-",
            dir=target.parent,
        )

        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)

            os.replace(temporary, target)

        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    for old in old_status.get("catalogs", {}).values():
        filename = old.get("file", "")

        if (
            re.fullmatch(
                r"sources/[a-zA-Z0-9_-]+\.json",
                filename,
            )
            and filename not in outputs
        ):
            (root / filename).unlink(missing_ok=True)


def main():
    names = discover_catalogs()

    with ThreadPoolExecutor(max_workers=4) as executor:
        catalogs = list(
            executor.map(load_catalog, names)
        )

    repository = os.environ.get("GITHUB_REPOSITORY")
    branch = os.environ.get("GITHUB_REF_NAME", "main")

    base_url = (
        "https://raw.githubusercontent.com/"
        + repository
        + "/"
        + quote(branch, safe="")
        + "/public"
        if repository
        else None
    )

    outputs = generate(catalogs, base_url)
    save_outputs(outputs)

    status = outputs["status.json"]

    print(
        json.dumps(
            status,
            ensure_ascii=False,
            indent=2,
        )
    )

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")

    if summary_path:
        with open(
            summary_path,
            "a",
            encoding="utf-8",
        ) as handle:
            handle.write(
                f"# {SOURCE_NAME}\n\n"
                f"Apps: {status['apps']}\n\n"
                f"Catalogs: {len(catalogs)}\n\n"
            )

            if base_url:
                handle.write(
                    f"[Test source]"
                    f"({base_url}/repo-test.json)\n\n"
                    f"[Full source]"
                    f"({base_url}/repo.json)\n"
                )


if __name__ == "__main__":
    try:
        main()

    except Exception as error:
        print(
            "IPA BLACK sync failed; "
            "existing remote source was preserved: "
            + str(error),
            file=sys.stderr,
        )

        sys.exit(1)
