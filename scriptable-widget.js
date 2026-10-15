// ============================================================
//  待办清单 · Scriptable 小组件
//  用法：
//    1. iPhone 安装免费 App「Scriptable」
//    2. 新建脚本，粘贴本文件全部内容
//    3. 把下面 3 个值改成你的真实值（与电脑端设置一致）
//    4. 点 ▶ 试跑，确认能显示待办
//    5. 桌面长按 → 左上角 ＋ → Scriptable → 选尺寸 → 选本脚本
// ============================================================

const GITEE_OWNER = 'mou-biheng';
const GITEE_REPO = 'todo-sync';
const GITEE_TOKEN = '87ba3b063dcf2a319a6a98340cc2909c';
const GITEE_PATH = 'todo-sync.json';

const PRIO_COLORS = ['#8a8f9e', '#4a90d9', '#f5a623', '#e5484d']; // 无/低/中/高

function configured() {
  return GITEE_OWNER && GITEE_OWNER.indexOf('你的') === -1 &&
         GITEE_REPO && GITEE_REPO.indexOf('你的') === -1 &&
         GITEE_TOKEN && GITEE_TOKEN.indexOf('你的') === -1;
}

async function main() {
  const w = new ListWidget();
  w.setPadding(14, 14, 14, 14);
  w.backgroundColor = Color.dynamic(new Color('#f4f5f9'), new Color('#171921'));

  const textColor = Color.dynamic(new Color('#1c1e26'), new Color('#e8eaf1'));
  const mutedColor = Color.dynamic(new Color('#8a8f9e'), new Color('#9aa0b0'));

  const family = config.widgetFamily || 'medium';
  const LIMIT = { small: 3, medium: 6, large: 10 }[family] || 6;

  // 标题
  const head = w.addStack();
  head.layoutHorizontally();
  const title = head.addText('待办清单');
  title.font = Font.boldSystemFont(17);
  title.textColor = textColor;
  head.addSpacer();
  w.addSpacer(6);

  // 未配置：直接提示，不联网
  if (!configured()) {
    const a = w.addText('还没配置同步');
    a.font = Font.boldSystemFont(15);
    a.textColor = textColor;
    const b = w.addText('请打开这个脚本，填顶部三行：\nGITEE_OWNER / GITEE_REPO / GITEE_TOKEN');
    b.font = Font.systemFont(12);
    b.textColor = mutedColor;
    return present(w);
  }

  try {
    const url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(GITEE_OWNER) +
      '/' + encodeURIComponent(GITEE_REPO) + '/contents/' + GITEE_PATH +
      '?access_token=' + encodeURIComponent(GITEE_TOKEN);
    const req = new Request(url);
    const file = await req.loadJSON();

    const d = file && file.content ? JSON.parse(Data.fromBase64String(String(file.content).replace(/\s/g, '')).toRawString()) : null;
    if (!d || !Array.isArray(d.items)) {
      const t = w.addText('云端暂无数据');
      t.font = Font.systemFont(14);
      t.textColor = mutedColor;
      return present(w);
    }

    const items = d.items;
    const cats = Array.isArray(d.categories) ? d.categories : [];
    const catColor = (id) => { const c = cats.find(x => x.id === id); return c ? c.color : null; };

    const pending = items.filter(it => !it.done);

    const cnt = head.addText(pending.length + '/' + items.length);
    cnt.font = Font.mediumSystemFont(13);
    cnt.textColor = mutedColor;

    if (pending.length === 0) {
      const empty = w.addText(items.length > 0 ? '全部完成 🎉' : '暂无待办');
      empty.font = Font.systemFont(14);
      empty.textColor = mutedColor;
    } else {
      const sorted = pending.slice().sort((a, b) =>
        (b.priority || 0) - (a.priority || 0) || (a.createdAt || 0) - (b.createdAt || 0)
      );
      for (let i = 0; i < Math.min(sorted.length, LIMIT); i++) {
        const it = sorted[i];
        const row = w.addStack();
        row.layoutHorizontally();
        row.centerAlignContent();

        const dot = row.addText('●');
        dot.font = Font.systemFont(10);
        dot.textColor = new Color(PRIO_COLORS[it.priority || 0] || PRIO_COLORS[0]);
        row.addSpacer(4);

        const cc = catColor(it.category);
        if (cc) {
          const cd = row.addText('●');
          cd.font = Font.systemFont(10);
          cd.textColor = new Color(cc);
          row.addSpacer(4);
        }

        const t = row.addText(it.text);
        t.font = Font.systemFont(13);
        t.textColor = textColor;
        t.lineLimit = 1;
      }
    }

    w.addSpacer();
    const foot = w.addText('☁️ 更新于 ' + fmtTime(d.updatedAt));
    foot.font = Font.systemFont(10);
    foot.textColor = mutedColor;
    foot.textOpacity = 0.7;
  } catch (e) {
    const err = w.addText('同步失败');
    err.font = Font.boldSystemFont(14);
    err.textColor = Color.red();
    const m = w.addText(String(e && e.message ? e.message : e));
    m.font = Font.systemFont(11);
    m.textColor = Color.gray();
  }

  present(w);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function present(w) {
  Script.setWidget(w);
  Script.complete();
}

// 兜底：万一 main 里任何地方抛异常，也保证显示一个小组件（而不是没反应）
(async () => {
  try { await main(); }
  catch (e) {
    const w = new ListWidget();
    const t = w.addText('脚本出错');
    t.font = Font.boldSystemFont(15);
    t.textColor = Color.red();
    const m = w.addText(String(e && e.message ? e.message : e));
    m.font = Font.systemFont(11);
    m.textColor = Color.gray();
    Script.setWidget(w);
    Script.complete();
  }
})();
