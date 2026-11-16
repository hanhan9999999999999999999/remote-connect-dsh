# -*- coding: utf-8 -*-
"""
asset_v3.py — 资产库 v3：混合仓（实体入库 + 引用登记）

v3 定稿（2026-09-22 与用户对齐）：
1. 混合仓：笔记/速记/链接 = 实体住库里；大文件/任务文件 = 记引用不搬家（>10MB 不拷贝）
2. 库目录结构（在资产库根下）：
       notes/    笔记（markdown，YAML frontmatter）
       snippets/ 速记（纯文本碎片）
       links/    链接收藏（markdown 存 URL+摘要）
       files/    收纳的实体文件（≤10MB 拷贝入库，按年月分目录；md5 去重）
3. 极低记录成本：所有写操作一步完成，自动起标题，不弹窗打断
4. 路径安全：所有读写限制在库目录内（防穿越）
5. 复用 asset_lib 的索引与登记制：入库的实体同时登记进 index.json，
   保持"库里能看到一切"的单一口径
"""
import hashlib
import json
import os
import re
import time

import tools.asset_lib as asset_lib

# 收纳实体文件的体积阈值：≤10MB 拷贝入库，超过只登记引用
COPY_MAX_BYTES = 10 * 1024 * 1024

_SUBDIRS = ("notes", "snippets", "links", "files")


# ── 基础 ─────────────────────────────────────────────

def _lib():
    d = asset_lib.get_lib_dir()
    for s in _SUBDIRS:
        os.makedirs(os.path.join(d, s), exist_ok=True)
    return d


def _safe_rel(rel):
    """校验相对路径不越出库目录，返回绝对路径。"""
    lib = os.path.normpath(_lib())
    p = os.path.normpath(os.path.join(lib, str(rel or "")))
    if not (p == lib or p.startswith(lib + os.sep)):
        raise ValueError("路径不在资产库里")
    return p


def _slug(title, fallback="untitled"):
    t = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", str(title or "").strip())
    t = re.sub(r"\s+", " ", t).strip(" ._")
    t = t[:60] or fallback
    return t


def _uniq(dirpath, name):
    """目录内重名自动加序号：a.md → a-2.md"""
    base, ext = os.path.splitext(name)
    cand = name
    i = 2
    while os.path.exists(os.path.join(dirpath, cand)):
        cand = "%s-%d%s" % (base, i, ext)
        i += 1
    return cand


def _frontmatter(title, tags, source_task):
    lines = ["---",
             "title: %s" % title,
             "created: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
             "tags: %s" % (", ".join(tags) if tags else ""),
             "source_task: %s" % (source_task or ""),
             "---", ""]
    return "\n".join(lines)


def _register(path, name, kind, tags, source_task):
    """实体入库后登记进 index.json（复用登记制，库里单一口径可见）。"""
    try:
        return asset_lib.add_asset({
            "path": path, "name": name, "type": kind,
            "tags": list(tags or []), "source_task": source_task or "",
        })
    except Exception:
        return None  # 登记失败不阻塞写入（文件本身已落盘）


def _touch(path):
    """更新既有登记的 updated_at（保存笔记时用），找不到登记就静默跳过。"""
    try:
        recs = asset_lib.list_assets()
        norm = os.path.normcase(os.path.normpath(path))
        for a in recs:
            if os.path.normcase(os.path.normpath(a.get("path") or "")) == norm:
                asset_lib.update_asset(a["id"], {"updated_at": int(time.time())})
                return
    except Exception:
        pass


# ── 笔记 ─────────────────────────────────────────────

def new_note(title, body="", tags=None, source_task=""):
    # 空参数不该造出一个空笔记：以前 {} 会落一条「新笔记.md」（只有 frontmatter），
    # 前端一次误调用就在库里留一个空壳，还分不清是用户建的还是接口造的。
    title_raw = str(title or "").strip()
    body_raw = str(body or "")
    if not title_raw and not body_raw.strip():
        raise ValueError("没有内容可写：标题和正文至少给一个")
    title = _slug(title_raw or body_raw.strip().split("\n")[0][:24], "新笔记")
    d = os.path.join(_lib(), "notes")
    fp = os.path.join(d, _uniq(d, title + ".md"))
    content = _frontmatter(title, tags, source_task) + (body or "")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(content)
    rec = _register(fp, title, "note", tags, source_task) or {}
    # 顺手把 id/tags 带回去：REST 语义上"创建成功"应该能拿到句柄，
    # 否则前端/模型还得再查一次库才知道刚建的是哪一条
    return {"id": rec.get("id"), "path": fp, "name": title, "title": title,
            "tags": rec.get("tags") or list(tags or [])}


def new_snippet(text, tags=None, source_task=""):
    text = str(text or "").strip()
    if not text:
        raise ValueError("没有内容可存")
    title = _slug(text.split("\n")[0][:24], "速记")
    d = os.path.join(_lib(), "snippets")
    fp = os.path.join(d, _uniq(d, time.strftime("%m%d-%H%M%S") + "-" + title + ".txt"))
    with open(fp, "w", encoding="utf-8") as f:
        f.write(text)
    rec = _register(fp, title, "snippet", tags, source_task) or {}
    return {"id": rec.get("id"), "path": fp, "name": title, "title": title,
            "tags": rec.get("tags") or list(tags or [])}


def _fetch_page_title(url, timeout=2.5):
    """尽力抓一下网页 <title>。抓不到就返回空串 —— 存链接不该因为对方站点慢而失败。"""
    try:
        import urllib.request
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; BigEyeAsset/1.0)",
            "Accept": "text/html,*/*;q=0.8",
        })
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read(400000)
        m = re.search(rb"<title[^>]*>(.*?)</title>", raw, re.I | re.S)
        if not m:
            return ""
        txt = m.group(1).decode("utf-8", "replace")
        txt = re.sub(r"\s+", " ", txt).strip()
        return txt[:80]
    except Exception:
        return ""


def new_link(url, note="", tags=None, source_task="", title=""):
    url = str(url or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise ValueError("链接要以 http:// 或 https:// 开头")
    host = re.match(r"^https?://([^/]+)", url, re.I).group(1)
    # 名字优先级：调用方给的标题 > 备注首行 > 网页 <title> > 域名
    disp = str(title or "").strip()
    if not disp and note:
        disp = str(note).split("\n")[0][:40]
    if not disp:
        disp = _fetch_page_title(url)
    if not disp:
        disp = host
    title = _slug(disp, host)
    d = os.path.join(_lib(), "links")
    fp = os.path.join(d, _uniq(d, title + ".md"))
    content = _frontmatter(title, tags, source_task) + \
        "- 链接: %s\n- 来源: %s\n\n%s\n" % (url, host, note or "")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(content)
    rec = _register(fp, title, "link", tags, source_task) or {}
    return {"id": rec.get("id"), "path": fp, "name": title, "title": title, "url": url,
            "tags": rec.get("tags") or list(tags or [])}


# ── 文件收纳（混合仓的关键分支） ─────────────────────

def _hashmap_path():
    return os.path.join(_lib(), "files", ".hashes.json")


def _load_hashes():
    try:
        with open(_hashmap_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def import_file(src, tags=None, source_task=""):
    """收纳入口：≤10MB 拷贝入库（md5 去重）；>10MB 只登记引用不搬家。
    返回 {moved, path, name, dedup}"""
    src = os.path.normpath(str(src or ""))
    if not os.path.isfile(src):
        raise ValueError("文件不存在：%s" % src)
    name = os.path.basename(src)
    size = os.path.getsize(src)
    if size > COPY_MAX_BYTES:
        # 大文件：记引用，原地不动
        _register(src, name, "file", tags, source_task)
        return {"moved": False, "path": src, "name": name, "dedup": False}
    with open(src, "rb") as f:
        h = hashlib.md5(f.read()).hexdigest()
    hm = _load_hashes()
    if h in hm and os.path.isfile(os.path.join(_lib(), hm[h])):
        # 同内容文件已入库：直接指向已有副本，不重复占空间
        rel = hm[h]
        _register(os.path.join(_lib(), rel), name, "file", tags, source_task)
        return {"moved": True, "path": os.path.join(_lib(), rel),
                "name": name, "dedup": True}
    sub = time.strftime("%Y-%m")
    d = os.path.join(_lib(), "files", sub)
    os.makedirs(d, exist_ok=True)
    fp = os.path.join(d, _uniq(d, name))
    try:
        with open(src, "rb") as s, open(fp, "wb") as t:
            while True:
                buf = s.read(1 << 20)
                if not buf:
                    break
                t.write(buf)
    except Exception:
        try:
            os.remove(fp)
        except OSError:
            pass
        raise
    rel = os.path.relpath(fp, _lib())
    hm[h] = rel
    try:
        with open(_hashmap_path(), "w", encoding="utf-8") as f:
            json.dump(hm, f, ensure_ascii=False, indent=1)
    except Exception:
        pass
    _register(fp, os.path.splitext(name)[0], "file", tags, source_task)
    return {"moved": True, "path": fp, "name": name, "dedup": False}


# ── 读取 / 保存（库内安全读写） ───────────────────────

# ── 浏览（库=能逛的仓库） ─────────────────────────

def _walk_files(d):
    out = []
    for root, _dirs, names in os.walk(d):
        for n in names:
            fp = os.path.join(root, n)
            try:
                out.append({"name": n, "path": fp, "mtime": int(os.path.getmtime(fp))})
            except OSError:
                pass
    return out


def lib_overview():
    """库总览：四个分区各自的计数与最近条目（库页首屏）。"""
    lib = _lib()
    out = {"lib_dir": lib, "sections": {}}
    labels = (("notes", "笔记"), ("snippets", "速记"), ("links", "链接"), ("files", "文件"))
    for sub, label in labels:
        d = os.path.join(lib, sub)
        items = _walk_files(d)
        items.sort(key=lambda x: -x["mtime"])
        out["sections"][sub] = {"label": label, "count": len(items), "items": items[:8]}
    return out


def browse(sub, rel=""):
    """浏览某分区的子目录（files/ 下按年月分层，需要能进子目录）。"""
    if sub not in _SUBDIRS:
        raise ValueError("没找到这一节：%s" % sub)
    base = os.path.normpath(os.path.join(_lib(), sub))
    d = os.path.normpath(os.path.join(base, str(rel or "")))
    if not (d == base or d.startswith(base + os.sep)):
        raise ValueError("这一段路径越界")
    files, dirs = [], []
    try:
        names = sorted(os.listdir(d))
    except OSError as e:
        raise ValueError(str(e))
    for n in names:
        fp = os.path.join(d, n)
        try:
            st = os.stat(fp)
        except OSError:
            continue
        item = {"name": n, "path": fp, "mtime": int(st.st_mtime)}
        if os.path.isdir(fp):
            dirs.append(item)
        else:
            item["size"] = st.st_size
            files.append(item)
    return {"sub": sub, "path": os.path.relpath(d, base) if d != base else "",
            "dirs": dirs, "files": files}


def _registered_dir_covers(path):
    """path 是否落在某个已登记的目录（含 project）之下。

    资产库的「浏览」是从一个已登记目录往下走的：里面的文件不会逐个登记，
    但既然这个目录是用户自己登记进来的，它下面的文件也该能站内预览。
    """
    p = os.path.normpath(str(path or ""))
    if not p:
        return False
    try:
        recs = asset_lib.list_assets()
    except Exception:
        return False
    for r in recs:
        if str(r.get("type") or "") not in ("dir", "project"):
            continue
        base = os.path.normpath(str(r.get("path") or ""))
        if base and (p == base or p.startswith(base + os.sep)):
            return True
    return False


def read_text(rel_or_abs):
    """读文本。库内按相对/绝对路径都行；库外的文件只有【已在资产索引登记】才放行。

    资产是登记制：用户可以把 D:\项目\notes.md 登记进库，点开时想在页内看内容，
    所以这里把"已登记"当作读授权（与 /api/assets/preview 的白名单同一条规矩）。
    """
    raw = str(rel_or_abs or "").strip()
    if not raw:
        raise ValueError("路径不能为空")
    lib = os.path.normpath(_lib())
    cand = os.path.normpath(raw if os.path.isabs(raw) else os.path.join(lib, raw))
    inside = cand == lib or cand.startswith(lib + os.sep)
    if inside:
        fp = _safe_rel(rel_or_abs)
    else:
        if not asset_lib.find_by_path(cand) and not _registered_dir_covers(cand):
            raise ValueError("路径未登记")
        fp = cand
    if not os.path.isfile(fp):
        raise ValueError("目标不是一个文件")
    with open(fp, "r", encoding="utf-8", errors="replace") as f:
        return f.read()


def save_text(rel_or_abs, body):
    fp = _safe_rel(rel_or_abs)
    if not os.path.isfile(fp):
        raise ValueError("只写资产库里的文件")
    with open(fp, "w", encoding="utf-8") as f:
        f.write(str(body or ""))
    _touch(fp)
    return {"path": fp, "saved_at": int(time.time())}


def delete_entry(rel_or_abs):
    """删除库内实体；登记在库外的文件只解除登记，绝不删用户的文件。

    以前这里一律走 _safe_rel：库外路径直接抛 "path escapes library"，
    于是「登记了 D:\某个项目里的文件」之后就再也删不掉这条登记了（文件本身也不该被删）。
    """
    raw = str(rel_or_abs or "").strip()
    if not raw:
        raise ValueError("路径不能为空")
    lib = os.path.normpath(_lib())
    cand = os.path.normpath(raw if os.path.isabs(raw) else os.path.join(lib, raw))
    inside = cand == lib or cand.startswith(lib + os.sep)
    if not inside:
        hit = [a for a in asset_lib.list_assets()
               if os.path.normcase(os.path.normpath(a.get("path") or "")) == os.path.normcase(cand)]
        if not hit:
            raise ValueError("这个路径还没登记到资产库")
        for a in hit:
            asset_lib.delete_asset(a["id"])
        return {"unregistered": cand}
    fp = _safe_rel(rel_or_abs)
    lib = os.path.normpath(_lib())
    rel = os.path.relpath(fp, lib)
    if rel.split(os.sep)[0] == "files" and os.path.isfile(fp):
        # files/ 下的实体：顺手清 hash 表引用
        try:
            hm = _load_hashes()
            hit = [k for k, v in hm.items()
                   if os.path.normcase(v) == os.path.normcase(rel)]
            for k in hit:
                del hm[k]
            if hit:
                with open(_hashmap_path(), "w", encoding="utf-8") as f:
                    json.dump(hm, f, ensure_ascii=False, indent=1)
        except Exception:
            pass
    if not os.path.isfile(fp):
        # 文件已经不在（手动删了，或上一次只删文件没删登记）：清掉这条僵尸登记，把事实说清楚
        norm = os.path.normcase(fp)

        def _abs_of(a):
            # 索引里的路径可能是相对的（links/xxx.md），也可能已是绝对路径 —— 归成绝对再比
            p = str(a.get("path") or "")
            return os.path.normcase(os.path.normpath(p if os.path.isabs(p) else os.path.join(lib, p)))

        stale = [a for a in asset_lib.list_assets() if _abs_of(a) == norm]
        for a in stale:
            asset_lib.delete_asset(a["id"])
        if stale:
            return {"cleared_stale": fp, "count": len(stale)}
        raise ValueError("目标不是一个文件")
    os.remove(fp)
    try:
        recs = asset_lib.list_assets()
        norm = os.path.normcase(fp)
        for a in recs:
            if os.path.normcase(os.path.normpath(a.get("path") or "")) == norm:
                asset_lib.delete_asset(a["id"])
                break
    except Exception:
        pass
    return {"deleted": fp}
