"""清空记忆的回归自测：delete_all 必须把派生的关系/连线/实体一起清掉。

为什么单独写一条：这些表是"从碎片长出来的"，只清碎片的话，反射回路会顺着残留的关系边
找到已删的碎片 id，继续涌现元晶、报知识缺口（实测清空后还能"涌现"5 个元晶 + 3 条观察）。
用临时库跑，不碰 data/chat.db。
"""

import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from memory.fragment_store import FragmentStore  # noqa: E402


def main() -> int:
    tmpdir = tempfile.mkdtemp(prefix='dsh-memclr-')
    db = os.path.join(tmpdir, 'mem.db')
    store = FragmentStore(db)
    ids = []
    for i in range(3):
        fid = store.add(f'清空自检记忆 {i}：这是一段用于验证 delete_all 的文本，内容足够长以通过长度门槛。',
                        source='selftest', tags='selfcheck')
        if fid:
            ids.append(fid)
    if len(ids) < 3:
        print('FAIL: 只写入了', len(ids), '条碎片')
        return 1

    conn = sqlite3.connect(db)
    # 新库里只有 fragments：关系/连线/实体表由各自的 store 建。这里按真实 schema 补最小结构。
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS memory_links (from_id INTEGER, to_id INTEGER, link_type TEXT, weight REAL, created_at REAL);
        CREATE TABLE IF NOT EXISTS memory_relations (id INTEGER PRIMARY KEY AUTOINCREMENT, subject_id INTEGER,
            predicate TEXT, object_id INTEGER, object_value TEXT, valid_from REAL, valid_to REAL, status TEXT,
            source_fragment_id INTEGER, confidence REAL, edge_type TEXT, embedding TEXT, reason TEXT, negate_timestamp REAL);
        CREATE TABLE IF NOT EXISTS memory_entities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, type TEXT,
            aliases TEXT, first_seen REAL, last_seen REAL, mention_count INTEGER, embedding TEXT, status TEXT);
        CREATE TABLE IF NOT EXISTS memory_summary_nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
    """)
    a, b = ids[0], ids[1]
    conn.execute('INSERT INTO memory_links (from_id,to_id,link_type,weight,created_at) VALUES (?,?,?,?,0)',
                 (a, b, 'weak_assoc', 0.6))
    conn.execute('INSERT INTO memory_relations (subject_id,predicate,object_id,status,edge_type) '
                 'VALUES (?,?,?,?,?)', (a, 'related_to', b, 'active', 'weak_assoc'))
    conn.execute('INSERT INTO memory_entities (name,type,mention_count,status) VALUES (?,?,?,?)',
                 ('自检实体', 'concept', 5, 'active'))
    conn.commit()
    conn.close()

    # 单条删除也要摘边：先只删 a，验证连到 a 的连线/关系消失、连到 b 的还在
    store.delete(a)
    conn = sqlite3.connect(db)
    one_left = {
        'links': conn.execute('SELECT COUNT(*) FROM memory_links').fetchone()[0],
        'relations': conn.execute('SELECT COUNT(*) FROM memory_relations').fetchone()[0],
    }
    conn.close()
    if one_left != {'links': 0, 'relations': 0}:
        print('FAIL: 单条删除后仍留着边 ->', one_left)
        return 1

    store.delete_all()

    conn = sqlite3.connect(db)
    left = {t: conn.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
            for t in ('memory_links', 'memory_relations', 'memory_entities')}
    dirty = conn.execute('SELECT COUNT(*) FROM memory_fragments WHERE dirty=1').fetchone()[0]
    conn.close()

    ok = all(v == 0 for v in left.values()) and dirty == 0
    print('left ->', left, 'dirty ->', dirty)
    print('RESULT:', 'OK' if ok else 'FAIL')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
