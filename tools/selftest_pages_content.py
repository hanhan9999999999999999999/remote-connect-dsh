"""知识页成文：没配 LLM 时也不能把 list 塞进 content 列。
历史 bug：sqlite 报 Error binding parameter 3: type 'list' is not supported，
每个页面都建不成（日志里 [reflection] page absorb(create) failed）。"""
import os, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory.knowledge_pages import KnowledgePageStore

tmp = tempfile.mkdtemp(prefix='kp_')
db = os.path.join(tmp, 'kp.db')
store = KnowledgePageStore(db_path=db, llm_call_fn=None)

conn = store._conn()
try:
    conn.execute(
        "INSERT INTO knowledge_pages (page_key, title, centroid, obs_ids, created_at, updated_at) "
        "VALUES (?,?,?,?,?,?)", ('自检页', '', '[]', '[]', 0, 0))
    pid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    conn.commit()
    # 绕过 observations 表：直接给三段原文
    store._get_obs_texts = lambda c, ids: ['第一段', '第二段', '第三段']
    res = store._materialize(conn, pid, '自检页', [1, 2, 3], first=True)
    row = conn.execute("SELECT content FROM knowledge_page_versions WHERE page_id=?", (pid,)).fetchone()
    ok = res.get('action') == 'versioned' and isinstance(row['content'], str) and '第二段' in row['content']
    print('RESULT:', 'OK' if ok else 'FAIL', '|', res, '|', (row['content'] or '')[:30].replace('\n', ' / '))
    sys.exit(0 if ok else 1)
finally:
    conn.close()
