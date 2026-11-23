#!/usr/bin/env bash
# 把 seed.json 导入 KV（部署后执行一次）
# 前置条件：
#   1. 已 wrangler login（Cloudflare 账号 sneoas@163.com）
#   2. wrangler.toml 里的 STATION_KV namespace id 已填好
#   3. 在仓库根目录执行：bash scripts/seed.sh
set -euo pipefail
cd "$(dirname "$0")/.."

python3 - <<'PY'
import json, subprocess, tempfile, os

seed = json.load(open('seed.json'))
for key, value in seed['keys'].items():
    with tempfile.NamedTemporaryFile('w', suffix='.json', delete=False) as f:
        json.dump(value, f, ensure_ascii=False)
        path = f.name
    try:
        subprocess.run(
            ['wrangler', 'kv', 'key', 'put', key, '--binding', 'STATION_KV', '--path', path],
            check=True,
        )
        print('seeded', key)
    finally:
        os.unlink(path)
print('done. history +', len(seed['keys']) - 1, 'session keys imported.')
PY
