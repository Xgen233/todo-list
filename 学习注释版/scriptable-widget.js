// ============================================================
//  待办清单 · Scriptable 小组件（iOS 桌面小组件）
// ============================================================
//  作用：在 iPhone 桌面上显示待办清单（只读展示，不能勾选）。
//  原理：Scriptable 是一个免费 iOS App，能用 JS 写「桌面小组件」。
//        本脚本从 Gitee 读电脑端同步上去的数据（同一份 todo-sync.json），
//        渲染成一个 ListWidget（列表型小组件）。
//
//  用法：
//    1. iPhone 安装免费 App「Scriptable」
//    2. 新建脚本，粘贴本文件全部内容
//    3. 把下面 3 个值改成你的真实值（与电脑端设置一致）
//    4. 点 ▶ 试跑，确认能显示待办
//    5. 桌面长按 → 左上角 ＋ → Scriptable → 选尺寸 → 选本脚本
// ============================================================

// 这三个是「同步密钥」，需要和电脑端「云端同步」设置里填的一致
// ★ 学习版已把真实的令牌隐藏成占位符，请填你自己的值（电脑端设置面板里能查到）
const GITEE_OWNER = '你的-Gitee-用户名';     // 例如：mou-biheng
const GITEE_REPO = '你的-仓库名';           // 例如：todo-sync
const GITEE_TOKEN = '你的-私人令牌-PAT';     // ★ 不要把你的真实令牌写进发给别人的文件
const GITEE_PATH = 'todo-sync.json';                    // 仓库里的数据文件名

// 优先级颜色：下标 0~3 对应 无/低/中/高（和电脑端一致）
const PRIO_COLORS = ['#8a8f9e', '#4a90d9', '#f5a623', '#e5484d'];

// 检查三个常量是否还停留在「你的」占位符（未配置）
function configured() {
  return GITEE_OWNER && GITEE_OWNER.indexOf('你的') === -1 &&
         GITEE_REPO && GITEE_REPO.indexOf('你的') === -1 &&
         GITEE_TOKEN && GITEE_TOKEN.indexOf('你的') === -1;
}

async function main() {
  // ListWidget：Scriptable 的列表型小组件容器
  const w = new ListWidget();
  w.setPadding(14, 14, 14, 14); // 内边距（上 右 下 左）
  // 背景色：浅色模式 #f4f5f9，深色模式 #171921（Color.dynamic 自动跟随系统）
  w.backgroundColor = Color.dynamic(new Color('#f4f5f9'), new Color('#171921'));

  // 文字颜色同样做浅/深两套
  const textColor = Color.dynamic(new Color('#1c1e26'), new Color('#e8eaf1'));
  const mutedColor = Color.dynamic(new Color('#8a8f9e'), new Color('#9aa0b0'));

  // 小组件尺寸（小/中/大），决定最多显示几条
  const family = config.widgetFamily || 'medium';
  const LIMIT = { small: 3, medium: 6, large: 10 }[family] || 6;

  // 标题栏
  const head = w.addStack();           // Stack：横向排一行的容器
  head.layoutHorizontally();
  const title = head.addText('待办清单');
  title.font = Font.boldSystemFont(17);
  title.textColor = textColor;
  head.addSpacer();                    // 弹性占位（把后面的内容推到右边）
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
    // 拼 Gitee 读文件接口，access_token 走查询参数（Gitee 私有仓库用 PAT 认证）
    const url = 'https://gitee.com/api/v5/repos/' + encodeURIComponent(GITEE_OWNER) +
      '/' + encodeURIComponent(GITEE_REPO) + '/contents/' + GITEE_PATH +
      '?access_token=' + encodeURIComponent(GITEE_TOKEN);
    const req = new Request(url);      // Scriptable 的网络请求对象
    const file = await req.loadJSON(); // 拿 JSON

    // Gitee 返回的文件内容是 base64 编码的 JSON 字符串：
    //   Data.fromBase64String(...).toRawString() = 先解码 base64 再转成字符串
    //   再 JSON.parse 还原成对象 { items, categories, updatedAt }
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

    const pending = items.filter(it => !it.done);   // 未完成的

    // 标题右侧显示「未完成/总数」计数
    const cnt = head.addText(pending.length + '/' + items.length);
    cnt.font = Font.mediumSystemFont(13);
    cnt.textColor = mutedColor;

    if (pending.length === 0) {
      const empty = w.addText(items.length > 0 ? '全部完成 🎉' : '暂无待办');
      empty.font = Font.systemFont(14);
      empty.textColor = mutedColor;
    } else {
      // 排序规则和电脑端一致：优先级高的在前，同优先级按创建时间升序
      const sorted = pending.slice().sort((a, b) =>
        (b.priority || 0) - (a.priority || 0) || (a.createdAt || 0) - (b.createdAt || 0)
      );
      // 最多显示 LIMIT 条
      for (let i = 0; i < Math.min(sorted.length, LIMIT); i++) {
        const it = sorted[i];
        const row = w.addStack();
        row.layoutHorizontally();
        row.centerAlignContent();

        // 优先级彩色圆点（用 ● 字符 + 颜色模拟）
        const dot = row.addText('●');
        dot.font = Font.systemFont(10);
        dot.textColor = new Color(PRIO_COLORS[it.priority || 0] || PRIO_COLORS[0]);
        row.addSpacer(4);

        // 分类彩色圆点（有分类才显示）
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
        t.lineLimit = 1;    // 单行，超长截断
      }
    }

    w.addSpacer();
    const foot = w.addText('☁️ 更新于 ' + fmtTime(d.updatedAt));
    foot.font = Font.systemFont(10);
    foot.textColor = mutedColor;
    foot.textOpacity = 0.7;
  } catch (e) {
    // 网络失败等异常：显示错误信息
    const err = w.addText('同步失败');
    err.font = Font.boldSystemFont(14);
    err.textColor = Color.red();
    const m = w.addText(String(e && e.message ? e.message : e));
    m.font = Font.systemFont(11);
    m.textColor = Color.gray();
  }

  present(w);
}

// 把毫秒时间戳格式化成「M/D H:MM」
function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 把小组件真正渲染出去（Scriptable 要求最后调这两个函数）
function present(w) {
  Script.setWidget(w);   // 设置要显示的小组件
  Script.complete();     // 告诉系统「脚本执行完毕」
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
