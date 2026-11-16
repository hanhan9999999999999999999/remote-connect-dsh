"""代码存档（时间机器）：把源码打成 zip，能列、能新建、能回滚。

只收"程序本身"——public / tools / memory / scripts / phone-bridge/src 与几个入口脚本，
不收 data（聊天记录/记忆库）、tmp、node_modules、models。回滚前会先自动存一份
当前状态，所以"回滚错了"还能再回滚回来。
"""
import hashlib
import json
import os
import time
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(ROOT, "data", "versions")
INDEX = os.path.join(STORE, "index.json")

SRC_DIRS = ["public", "tools", "memory", "scripts", "phone-bridge/src"]
SRC_FILES = ["server.py", "version_store.py", "db.py", "api_logger.py", "local_llm.py",
             "start.bat", "README.md", "PROJECT.md", "CHANGELOG.md"]
SKIP_DIRS = {"node_modules", "__pycache__", ".git", "models", "tmp"}
MAX_KEEP = 12


def _ensure():
    os.makedirs(STORE, exist_ok=True)


def _iter_files():
    for f in SRC_FILES:
        p = os.path.join(ROOT, f)
        if os.path.isfile(p):
            yield f.replace("\\", "/"), p
    for d in SRC_DIRS:
        base = os.path.join(ROOT, d)
        if not os.path.isdir(base):
            continue
        for dp, dns, fns in os.walk(base):
            dns[:] = [x for x in dns if x not in SKIP_DIRS]
            for fn in fns:
                if fn.endswith((".pyc", ".zip")):
                    continue
                p = os.path.join(dp, fn)
                rel = os.path.relpath(p, ROOT).replace("\\", "/")
                yield rel, p


def current_hash():
    h = hashlib.sha256()
    items = sorted(_iter_files(), key=lambda x: x[0])
    for rel, p in items:
        try:
            st = os.stat(p)
            h.update(rel.encode("utf-8"))
            h.update(str(st.st_size).encode())
        except OSError:
            continue
    return h.hexdigest()


def load_index():
    _ensure()
    try:
        with open(INDEX, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _save_index(entries):
    _ensure()
    tmp = INDEX + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=1)
    os.replace(tmp, INDEX)


def list_archives():
    entries = load_index()
    alive = []
    for e in entries:
        p = os.path.join(STORE, e.get("file", ""))
        if e.get("file") and os.path.isfile(p):
            alive.append(e)
    if len(alive) != len(entries):
        _save_index(alive)
    return sorted(alive, key=lambda x: x.get("created_at", 0), reverse=True)


def snapshot(label="auto"):
    _ensure()
    files = sorted(_iter_files(), key=lambda x: x[0])
    if not files:
        raise ValueError("没有可存档的源码")
    ts = time.time()
    # 名字必须唯一：同一秒里连存两份（比如"回滚前先备份"）不能互相覆盖，
    # 否则备份会把要回滚的那份 zip 盖掉 —— 回滚出来还是"改完"的内容。
    base = time.strftime("%Y%m%d-%H%M%S", time.localtime(ts)) + "-" + str(int(ts * 1000) % 1000000).zfill(6)
    name = base
    seq = 1
    while os.path.exists(os.path.join(STORE, name + ".zip")):
        seq += 1
        name = base + "-" + str(seq)
    zpath = os.path.join(STORE, name + ".zip")
    h = hashlib.sha256()
    total = 0
    with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for rel, p in files:
            try:
                st = os.stat(p)
                h.update(rel.encode("utf-8"))
                h.update(str(st.st_size).encode())
                z.write(p, rel)
                total += st.st_size
            except OSError:
                continue
        z.writestr("manifest.json", json.dumps({
            "created_at": ts, "label": label, "files": len(files), "bytes": total,
            "hash": h.hexdigest()[:16],
        }, ensure_ascii=False))
    entry = {
        "file": name + ".zip", "name": name, "created_at": ts,
        "label": label, "files": len(files), "bytes": total,
        "hash": h.hexdigest()[:16], "zip_bytes": os.path.getsize(zpath),
    }
    entries = load_index()
    entries.append(entry)
    # 只留最近 MAX_KEEP 份，旧的删掉（zip 与索引一起）
    entries = sorted(entries, key=lambda x: x.get("created_at", 0), reverse=True)
    keep, drop = entries[:MAX_KEEP], entries[MAX_KEEP:]
    for e in drop:
        try:
            os.remove(os.path.join(STORE, e.get("file", "")))
        except OSError:
            pass
    _save_index(keep)
    return entry


def restore(name, label="before-restore"):
    _ensure()
    if not name:
        raise ValueError("需要提供存档名")
    safe = os.path.basename(name)
    if not safe.endswith(".zip"):
        safe += ".zip"
    zpath = os.path.join(STORE, safe)
    if not os.path.isfile(zpath):
        raise ValueError("找不到这份存档：%s" % safe)
    backup = snapshot(label)          # 先留退路
    wrote = 0
    with zipfile.ZipFile(zpath) as z:
        for info in z.infolist():
            rel = info.filename
            if rel == "manifest.json":
                continue
            # 可疑路径不许"跳过就算"——跳过等于半份代码回滚，比直接拒绝更难查
            if rel.startswith("..") or rel.startswith("/") or ":" in rel or "\\" in rel.replace("/", ""):
                raise ValueError("存档里有可疑路径，拒绝回滚：%s" % rel)
            dest = os.path.join(ROOT, rel)
            os.makedirs(os.path.dirname(dest) or ROOT, exist_ok=True)
            with z.open(info) as src, open(dest, "wb") as out:
                out.write(src.read())
            wrote += 1
    return {"restored": safe, "files": wrote, "backup": backup["name"]}


def delete(name):
    safe = os.path.basename(name)
    if not safe.endswith(".zip"):
        safe += ".zip"
    entries = load_index()
    keep = [e for e in entries if e.get("file") != safe]
    if len(keep) == len(entries):
        raise ValueError("找不到这份存档：%s" % safe)
    try:
        os.remove(os.path.join(STORE, safe))
    except OSError:
        pass
    _save_index(keep)
    return {"deleted": safe}
