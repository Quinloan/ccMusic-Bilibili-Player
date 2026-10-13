# 用法: python scripts/upload_release_shots.py <版本号> <图片目录>
# 例:   python scripts/upload_release_shots.py 1.2.0 shots
# 行为: 把目录里的 png 作为附件传到 v<版本> Release，并在说明最前面插入「界面预览」图区。
import json
import os
import sys
import urllib.request

if len(sys.argv) < 3:
    sys.exit("用法: python scripts/upload_release_shots.py <版本号> <图片目录>")

VER = sys.argv[1].lstrip("v")
SHOTS_DIR = os.path.abspath(sys.argv[2])
OWNER, REPO = "Quinloan", "ccMusic-Bilibili-Player"
BASE = "https://api.github.com/repos/%s/%s" % (OWNER, REPO)
UPLOAD = "https://uploads.github.com/repos/%s/%s" % (OWNER, REPO)
TAG = "v" + VER

with open(os.path.expanduser("~/.workbuddy/.github_token"), encoding="utf-8") as f:
    TOKEN = f.read().strip()


def call(url, method="GET", data=None, headers=None, timeout=180):
    h = {"Authorization": "Bearer " + TOKEN,
         "Accept": "application/vnd.github+json",
         "User-Agent": "ccMusic-release"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
        return r.status, (json.loads(body) if body and r.headers.get("content-type", "").startswith("application/json") else body)


# 1. 找 Release
st, rel = call(BASE + "/releases/tags/" + TAG)
assert st == 200, "Release %s 不存在 (%s)" % (TAG, st)
rid, body = rel["id"], rel["body"] or ""
print("release:", rel["html_url"], "id=", rid)

# 2. 上传截图（同名先删）
existing = {a["name"]: a["id"] for a in call(BASE + "/releases/%s/assets?per_page=100" % rid)[1]}
pngs = sorted(p for p in os.listdir(SHOTS_DIR) if p.lower().endswith(".png"))
assert pngs, "目录里没有 png: " + SHOTS_DIR
urls = []
for name in pngs:
    if name in existing:
        call(BASE + "/releases/assets/" + str(existing[name]), method="DELETE")
        print("deleted old:", name)
    path = os.path.join(SHOTS_DIR, name)
    data = open(path, "rb").read()
    st, asset = call(UPLOAD + "/releases/%s/assets?name=%s" % (rid, name),
                     method="POST", data=data,
                     headers={"Content-Type": "image/png"})
    assert st == 201, "上传失败 %s: %s" % (name, asset)
    print("uploaded:", name, "%.1fKB" % (len(data) / 1024), asset["browser_download_url"])
    urls.append((name, asset["browser_download_url"]))

# 3. 更新说明：在开头插入预览区（若已插入过则先移除旧区再插入新的，保证可重复执行）
import re
label = {"01-library.png": "主界面（收藏夹 + 正在播放）",
         "02-search.png": "搜索结果（一键加入收藏夹）",
         "03-settings.png": "设置（居中悬浮卡片）",
         "04-queue.png": "播放列表（悬浮卡片，与收藏夹分离）",
         "05-group.png": "歌单多 P 分组（收起态，点击展开）",
         "06-menu.png": "账号菜单",
         "07-confirm.png": "删除前的确认弹窗"}.get
lines = ["## 界面预览", ""]
for name, u in urls:
    lines.append("![%s](%s)" % (label(name) or name, u))
preview = "\n".join(lines) + "\n"
body = re.sub(r"## 界面预览\n(?:!\[[^\]]*\]\([^)]*\)\n?)*\n?", "", body)
new_body = preview + "\n" + body.lstrip("\n")
st, _ = call(BASE + "/releases/" + str(rid), method="PATCH",
             data=json.dumps({"body": new_body}).encode("utf-8"),
             headers={"Content-Type": "application/json"})
assert st == 200, "更新说明失败 (%s)" % st
print("release body updated, 图片 %d 张" % len(urls))
