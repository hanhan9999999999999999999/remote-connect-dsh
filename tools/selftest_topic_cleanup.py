"""删任务时的数据一致性自检：碎片、知识页随任务一起清掉，别人的不许动。

用临时库跑，不碰 data/chat.db。
"""
import os
import sys
import json
import sqlite3
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import db as dbmod                      # noqa: E402
from memory.fragment_store import FragmentStore          # noqa: E402
from memory.knowledge_pages import KnowledgePageStore    # noqa: E402


def main():
    tmp = os.path.join(tempfile.gettempdir(), 'dshtest-clean-%d.db' % os.getpid())
    if os.path.exists(tmp):
        os.remove(tmp)
    d = dbmod.Database(tmp)
    FragmentStore(tmp)
    KnowledgePageStore(tmp)

    tid = d.create_topic('删任务清理自检')['id']
    mid = d.add_message(tid, 'user', '自检消息')

    c = sqlite3.connect(tmp)
    fid = c.execute(
        "INSERT INTO memory_fragments (text, ts, created_at, topic_id, weight, source) "
        "VALUES (?,?,?,?,?,?)", ('自检碎片', 0, 0, tid, 1.0, 'api')).lastrowid
    pid = c.execute(
        "INSERT INTO knowledge_pages (page_key,title,current_version,centroid,obs_ids,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?)", ('自检页', '', 1, '[]', json.dumps([fid]), 0, 0)).lastrowid
    c.execute("INSERT INTO knowledge_page_versions (page_id,version,content,created_at) VALUES (?,?,?,?)",
              (pid, 1, '正文', 0))
    fid2 = c.execute(
        "INSERT INTO memory_fragments (text, ts, created_at, topic_id, weight, source) "
        "VALUES (?,?,?,?,?,?)", ('活着', 0, 0, 'othertopic', 1.0, 'api')).lastrowid
    c.execute("INSERT INTO knowledge_pages (page_key,title,current_version,centroid,obs_ids,created_at,updated_at) "
              "VALUES (?,?,?,?,?,?,?)", ('活页', '', 0, '[]', json.dumps([fid2]), 0, 0))
    # 按 message_id / topic_id 挂的旁表（临时库里可能还没建，先建最小结构）
    c.execute("CREATE TABLE IF NOT EXISTS user_msg_vectors (message_id INTEGER PRIMARY KEY, vec TEXT, ts REAL)")
    c.execute("CREATE TABLE IF NOT EXISTS mindmap_history (id INTEGER PRIMARY KEY AUTOINCREMENT, "
              "topic_id TEXT, seq INTEGER, snapshot TEXT, action TEXT, source TEXT, created_at REAL)")
    c.execute("INSERT INTO user_msg_vectors (message_id, vec, ts) VALUES (?,?,?)", (mid, '[]', 0))
    c.execute("INSERT INTO mindmap_history (topic_id, seq, snapshot, action, source, created_at) "
              "VALUES (?,?,?,?,?,?)", (tid, 1, '{}', 'save', 'test', 0))
    c.commit()
    c.close()

    d.delete_topic(tid)

    c = sqlite3.connect(tmp)
    q = lambda sql, a=(): c.execute(sql, a).fetchone()[0]
    checks = {
        'topic': q('select count(*) from topics where id=?', (tid,)),
        'messages': q('select count(*) from messages where topic_id=?', (tid,)),
        'frags': q('select count(*) from memory_fragments where topic_id=?', (tid,)),
        'dead_page': q('select count(*) from knowledge_pages where id=?', (pid,)),
        'dead_vers': q('select count(*) from knowledge_page_versions where page_id=?', (pid,)),
        'live_page': q("select count(*) from knowledge_pages where page_key='活页'"),
        'live_frag': q('select count(*) from memory_fragments where id=?', (fid2,)),
        'vectors': q('select count(*) from user_msg_vectors where message_id=?', (mid,)),
        'mindmap': q('select count(*) from mindmap_history where topic_id=?', (tid,)),
    }
    c.close()
    try:
        d.close()
        os.remove(tmp)
    except Exception:
        pass

    bad = {k: v for k, v in checks.items()
           if (k.startswith('live_') and v != 1) or (not k.startswith('live_') and v != 0)}
    print('checks', checks, flush=True)
    print('RESULT:', 'OK' if not bad else ('BAD %s' % bad), flush=True)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
