# 文件版本链自测：历史能读、恢复能写回、恢复动作本身会留下可撤销的快照
import os, sys, sqlite3, tempfile, hashlib, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

class FakeDB:
    def __init__(self, conn):
        self.conn = conn
    def _fetchall(self, sql, params=None):
        cur = self.conn.execute(sql, params or [])
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]
    def _fetchone(self, sql, params=None):
        rows = self._fetchall(sql, params)
        return rows[0] if rows else None
    def _execute(self, sql, params=None):
        return self.conn.execute(sql, params or [])
    def _commit(self):
        self.conn.commit()

def main():
    tmp = tempfile.mkdtemp(prefix='ver-')
    dbp = os.path.join(tmp, 'x.db')
    conn = sqlite3.connect(dbp)
    conn.execute("""CREATE TABLE file_edit_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, topic_id TEXT, file_path TEXT, tool TEXT,
        turn INTEGER DEFAULT 0, parent_id INTEGER, before_hash TEXT, after_hash TEXT,
        before_content TEXT, operation TEXT, created_at REAL)""")
    fp = os.path.join(tmp, 'note.txt')
    with open(fp, 'w', encoding='utf-8') as f:
        f.write('v3\n')
    now = time.time()
    for before, after, tool, ts in [(None, 'v1\n', 'write_file', now-300),
                                    ('v1\n', 'v2\n', 'edit_file', now-200),
                                    ('v2\n', 'v3\n', 'edit_file', now-100)]:
        conn.execute("INSERT INTO file_edit_history (topic_id,file_path,tool,turn,parent_id,before_hash,after_hash,before_content,operation,created_at)"
                     " VALUES ('t',?,?,0,NULL,?,?,?,NULL,?)",
                     (fp, tool,
                      hashlib.sha256((before or '').encode()).hexdigest() if before else None,
                      hashlib.sha256(after.encode()).hexdigest(), before, ts))
    conn.commit()

    import db as dbmod
    dbmod.get_db = lambda: FakeDB(conn)
    from tools import file_tools as ft

    hist = ft.file_history(fp)
    assert len(hist['history']) == 3, hist
    assert hist['history'][0]['record_id'] == 3, hist

    rid = hist['history'][0]['record_id']
    res = ft.file_restore(fp, rid)
    assert res.get('result') == 'ok', res
    with open(fp, encoding='utf-8') as f:
        body = f.read()
    assert body == 'v2\n', repr(body)

    rows = conn.execute('SELECT tool, before_content FROM file_edit_history ORDER BY id').fetchall()
    assert rows[-1][0] == 'file_restore', rows
    assert rows[-1][1] == 'v3\n', rows   # 恢复前的快照
    print('versions=3 restored=%r undo_snapshot=%r RESULT: OK' % (body, rows[-1][1]))

main()
