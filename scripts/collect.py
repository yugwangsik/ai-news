#!/usr/bin/env python3
"""AI/IT Radar 수집기.

sources.json 에 정의된 RSS/Atom/RDF 피드와 YouTube 채널 피드를 한 번 훑어서
public/data/feed.json 하나로 떨굽니다. 표준 라이브러리만 사용하므로 설치 과정이
없고, 로컬 실행과 GitHub Actions 실행이 완전히 동일합니다.

    python3 scripts/collect.py

한 소스가 실패해도 전체를 중단하지 않고 건너뛰며, 실패 사실은 feed.json 의
sources 배열에 남아 화면 하단에 표시됩니다.
"""

import html
import json
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_FILE = ROOT / "sources.json"
OUT_DIR = ROOT / "public" / "data"

USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36 (+ai-it-radar collector)"
)
TIMEOUT = 20
RETRIES = 4
RETRY_BACKOFF = 4  # 초, 시도할수록 배수로 늘어납니다.
# YouTube 는 짧은 간격으로 연달아 때리면 404/500 을 돌려줍니다(채널이 없어서가
# 아니라 레이트리밋). 영상 소스는 간격을 크게 두고, 순서도 기사 소스 사이사이로
# 흩어 놓아 연속 호출이 생기지 않게 합니다.
DELAY_ARTICLE = 0.5
DELAY_VIDEO = 6
COOLDOWN = 45  # 실패한 소스를 다시 시도하기 전에 쉬는 시간(초)

MAX_ARTICLES = 250
MAX_VIDEOS = 60
SUMMARY_LEN = 180

# ---------------------------------------------------------------- 유틸


def log(msg):
    print(msg, flush=True)


def local_name(tag):
    """'{http://...}item' -> 'item'"""
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def find_child(el, *names):
    """네임스페이스를 무시하고 첫 번째로 일치하는 자식 엘리먼트를 돌려줍니다."""
    wanted = {n.lower() for n in names}
    for child in el:
        if local_name(child.tag).lower() in wanted:
            return child
    return None


def find_children(el, *names):
    wanted = {n.lower() for n in names}
    return [c for c in el if local_name(c.tag).lower() in wanted]


def text_of(el, *names):
    child = find_child(el, *names)
    if child is None:
        return ""
    return (child.text or "").strip()


TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def to_plain_text(raw, limit=SUMMARY_LEN):
    if not raw:
        return ""
    text = TAG_RE.sub(" ", raw)
    text = html.unescape(text)
    text = WS_RE.sub(" ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text


TRACKING_PARAMS = ("utm_", "fbclid", "gclid", "ref_src", "cmpid")


def normalize_url(url):
    """중복 판정을 위한 정규화. 저장되는 링크 자체는 건드리지 않습니다."""
    if not url:
        return ""
    url = url.strip()
    if "?" in url:
        base, _, query = url.partition("?")
        kept = [
            p
            for p in query.split("&")
            if p and not any(p.lower().startswith(t) for t in TRACKING_PARAMS)
        ]
        url = base + ("?" + "&".join(kept) if kept else "")
    url = re.sub(r"^https?://(www\.)?", "", url).rstrip("/")
    return url.lower()


def parse_date(raw):
    if not raw:
        return None
    raw = raw.strip()
    # RFC 822 (RSS 의 pubDate)
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except (TypeError, ValueError, IndexError):
        pass
    # ISO 8601 (Atom 의 published/updated, dc:date)
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def fetch(url):
    last_error = None
    for attempt in range(1, RETRIES + 1):
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": USER_AGENT,
                    "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
                    "Accept-Language": "ko,en;q=0.9,ja;q=0.8",
                },
            )
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read()
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as exc:
            last_error = exc
            if attempt < RETRIES:
                time.sleep(RETRY_BACKOFF * attempt)
    raise last_error


CTRL_RE = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def parse_xml(payload):
    try:
        return ET.fromstring(payload)
    except ET.ParseError:
        # 제어문자 등으로 깨진 피드를 한 번 더 살려봅니다.
        return ET.fromstring(CTRL_RE.sub(b"", payload))


# ---------------------------------------------------------------- 항목 추출


def entry_link(entry):
    """RSS 는 <link>텍스트</link>, Atom 은 <link href="..."/> 형태입니다."""
    links = find_children(entry, "link")
    for link in links:
        if (link.text or "").strip().startswith("http"):
            return link.text.strip()
    for link in links:
        rel = link.get("rel")
        if link.get("href") and rel in (None, "alternate"):
            return link.get("href").strip()
    guid = find_child(entry, "guid", "id")
    if guid is not None and (guid.text or "").strip().startswith("http"):
        return guid.text.strip()
    return ""


def entry_thumbnail(entry):
    group = find_child(entry, "group")  # media:group (YouTube)
    if group is not None:
        thumb = find_child(group, "thumbnail")
        if thumb is not None and thumb.get("url"):
            return thumb.get("url")
    for el in entry.iter():
        name = local_name(el.tag).lower()
        if name == "thumbnail" and el.get("url"):
            return el.get("url")
        if name in ("content", "enclosure"):
            url = el.get("url") or el.get("href")
            mime = (el.get("type") or "").lower()
            if url and mime.startswith("image"):
                return url
    return ""


def entry_summary(entry):
    for name in ("description", "summary", "subtitle"):
        child = find_child(entry, name)
        if child is not None and (child.text or "").strip():
            return to_plain_text(child.text)
    group = find_child(entry, "group")
    if group is not None:
        desc = find_child(group, "description")
        if desc is not None:
            return to_plain_text(desc.text)
    content = find_child(entry, "encoded", "content")
    if content is not None:
        return to_plain_text(content.text or "")
    return ""


def entry_date(entry):
    for name in ("pubdate", "published", "date", "updated", "modified"):
        dt = parse_date(text_of(entry, name))
        if dt:
            return dt
    return None


def collect_entries(root):
    """RSS 2.0 / RSS 1.0(RDF) / Atom 모두에서 항목 목록을 뽑습니다."""
    entries = []
    for el in root.iter():
        if local_name(el.tag).lower() in ("item", "entry"):
            entries.append(el)
    return entries


def video_id_of(entry):
    for el in entry.iter():
        if local_name(el.tag).lower() == "videoid" and (el.text or "").strip():
            return el.text.strip()
    return ""


# ---------------------------------------------------------------- 수집


def source_url(source):
    if source["type"] == "video":
        return (
            "https://www.youtube.com/feeds/videos.xml?channel_id="
            + source["channelId"]
        )
    return source["url"]


def harvest(source, cutoff):
    url = source_url(source)
    payload = fetch(url)
    root = parse_xml(payload)
    items = []
    for entry in collect_entries(root):
        title = to_plain_text(text_of(entry, "title"), limit=300)
        link = entry_link(entry)
        if not title or not link:
            continue
        published = entry_date(entry)
        if published is None or published < cutoff:
            continue
        item = {
            "id": f"{source['id']}:{normalize_url(link)}",
            "type": source["type"],
            "title": title,
            "url": link,
            "source": source["name"],
            "sourceId": source["id"],
            "region": source["region"],
            "publishedAt": published.astimezone(timezone.utc)
            .isoformat()
            .replace("+00:00", "Z"),
            "summary": entry_summary(entry),
            "thumbnail": entry_thumbnail(entry),
        }
        if source["type"] == "video":
            item["channel"] = source["name"]
            vid = video_id_of(entry)
            if vid and not item["thumbnail"]:
                item["thumbnail"] = f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg"
            item["summary"] = ""  # 유튜브 설명문은 카드에 쓰지 않습니다.
        items.append(item)
    return items


def load_previous():
    """직전 수집 결과의 항목들. 파일이 없거나 깨졌으면 빈 목록."""
    path = OUT_DIR / "feed.json"
    if not path.exists():
        return []
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("items", [])
    except (json.JSONDecodeError, OSError):
        return []


def interleave(sources):
    """영상 소스를 기사 소스 사이에 고르게 끼워 넣습니다.

    YouTube 피드를 연달아 요청하면 레이트리밋에 걸리는데, 사이에 다른 호스트
    요청이 들어가면 자연스럽게 간격이 벌어집니다.
    """
    articles = [s for s in sources if s["type"] != "video"]
    videos = [s for s in sources if s["type"] == "video"]
    if not videos:
        return articles
    step = max(1, len(articles) // len(videos))
    ordered, vq = [], list(videos)
    for index, source in enumerate(articles):
        ordered.append(source)
        if vq and (index + 1) % step == 0:
            ordered.append(vq.pop(0))
    ordered.extend(vq)
    return ordered


def main():
    config = json.loads(SOURCES_FILE.read_text(encoding="utf-8"))
    max_age_days = config.get("maxAgeDays", 30)
    cutoff = datetime.now(timezone.utc) - timedelta(days=max_age_days)
    sources = interleave([s for s in config["sources"] if s.get("enabled")])

    log(f"소스 {len(sources)}개 수집 시작 (최근 {max_age_days}일)")

    statuses = {}
    all_items = []

    def run(source):
        label = f"[{source['region']}] {source['name']}"
        base = {
            "id": source["id"],
            "name": source["name"],
            "region": source["region"],
            "type": source["type"],
        }
        try:
            items = harvest(source, cutoff)
            all_items.extend(items)
            statuses[source["id"]] = {**base, "ok": True, "count": len(items)}
            log(f"  ok   {label} — {len(items)}건")
            return True
        except Exception as exc:  # 한 소스의 실패가 전체를 막지 않습니다.
            statuses[source["id"]] = {
                **base,
                "ok": False,
                "count": 0,
                "error": f"{type(exc).__name__}: {exc}",
            }
            log(f"  FAIL {label} — {type(exc).__name__}: {exc}")
            return False

    for index, source in enumerate(sources):
        run(source)
        if index < len(sources) - 1:
            time.sleep(DELAY_VIDEO if source["type"] == "video" else DELAY_ARTICLE)

    # YouTube 는 IP 단위로 잠깐 막는 일이 잦습니다. 한 박자 쉬고 실패분만 재시도.
    retryable = [s for s in sources if not statuses[s["id"]]["ok"]]
    if retryable:
        log(f"\n실패한 {len(retryable)}개 소스를 {COOLDOWN}초 후 재시도합니다")
        time.sleep(COOLDOWN)
        for index, source in enumerate(retryable):
            run(source)
            if index < len(retryable) - 1:
                time.sleep(DELAY_VIDEO)

    # 그래도 실패한 소스는 직전 수집분을 물려받습니다. 일시적인 레이트리밋 한 번에
    # 이미 모아둔 항목이 화면에서 통째로 사라지는 걸 막습니다.
    previous = load_previous()
    for source in sources:
        status = statuses[source["id"]]
        if status["ok"]:
            continue
        kept = [
            item
            for item in previous
            if item.get("sourceId") == source["id"]
            and parse_date(item.get("publishedAt", ""))
            and parse_date(item["publishedAt"]) >= cutoff
        ]
        if kept:
            all_items.extend(kept)
            status["count"] = len(kept)
            status["stale"] = True
            log(f"  keep [{source['region']}] {source['name']} — 직전 수집분 {len(kept)}건 유지")

    statuses = [statuses[s["id"]] for s in sources]

    # 중복 제거: 같은 링크 또는 같은 제목이 여러 소스에서 올라오는 경우가 있습니다.
    seen_urls, seen_titles, deduped = set(), set(), []
    for item in sorted(all_items, key=lambda i: i["publishedAt"], reverse=True):
        url_key = normalize_url(item["url"])
        title_key = re.sub(r"\W+", "", item["title"].lower())[:80]
        if url_key in seen_urls or (title_key and title_key in seen_titles):
            continue
        seen_urls.add(url_key)
        seen_titles.add(title_key)
        deduped.append(item)

    articles = [i for i in deduped if i["type"] == "article"][:MAX_ARTICLES]
    videos = [i for i in deduped if i["type"] == "video"][:MAX_VIDEOS]
    items = sorted(articles + videos, key=lambda i: i["publishedAt"], reverse=True)

    feed = {
        "generatedAt": datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z"),
        "maxAgeDays": max_age_days,
        "counts": {
            "total": len(items),
            "articles": len(articles),
            "videos": len(videos),
            "sourcesOk": sum(1 for s in statuses if s["ok"]),
            "sourcesTotal": len(statuses),
        },
        "sources": statuses,
        "items": items,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(feed, ensure_ascii=False, indent=1)
    (OUT_DIR / "feed.json").write_text(payload + "\n", encoding="utf-8")
    # file:// 로 열었을 때 fetch 가 막히므로 <script> 로도 읽을 수 있게 같이 씁니다.
    (OUT_DIR / "feed.js").write_text(
        "window.__FEED__ = " + payload + ";\n", encoding="utf-8"
    )

    ok = feed["counts"]["sourcesOk"]
    log(
        f"\n완료: 기사 {len(articles)}건 / 영상 {len(videos)}건, "
        f"소스 {ok}/{len(statuses)} 성공 → public/data/feed.json"
    )
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
