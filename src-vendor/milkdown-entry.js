// esbuild 入口：把 Milkdown Crepe(Notion 式所见即所得 md 编辑器) 打成单文件 vendor
// 构建：npm run build:milkdown  → 产物 public/vendor/milkdown/milkdown.js + .css（运行时无构建）
import { Crepe } from '@milkdown/crepe';
import { imageBlockSchema } from '@milkdown/kit/component/image-block';
import { editorViewOptionsCtx, editorViewCtx } from '@milkdown/kit/core';
import { upload, uploadConfig } from '@milkdown/kit/plugin/upload';
import { $prose } from '@milkdown/kit/utils';
import { Plugin } from '@milkdown/kit/prose/state';
import '@milkdown/crepe/theme/common/style.css';
import '@milkdown/crepe/theme/frame.css';

// Milkdown 的 image-block 拿 alt 位存图片缩放比例：![封面图说明](url) 往返一趟变成 ![1.00](url)。
// alt 在花叔的文章里是图注正文（排版器、公众号都要读），丢了整篇就判「往返有损」被锁进源码模式。
// 这里把语义改回「alt 归 alt」：alt 文本原样往返；缩放比只在 alt 为空时借那个位置，
// 于是 Crepe 自己写出来的老文件（![1.00](url)）仍能读回比例，而人写的图注一个字都不动。
function keepImageAlt(editor) {
  return editor.config((ctx) => {
    ctx.update(imageBlockSchema.key, (make) => (c) => {
      const s = make(c);
      return {
        ...s,
        attrs: { ...s.attrs, alt: { default: '', validate: 'string' } },
        parseDOM: [{
          tag: 'img[data-type="image-block"]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src') || '',
            caption: dom.getAttribute('caption') || '',
            alt: dom.getAttribute('alt') || '',
            ratio: Number(dom.getAttribute('ratio')) || 1,
          }),
        }],
        parseMarkdown: {
          match: s.parseMarkdown.match,
          runner: (state, node, type) => {
            const raw = String(node.alt == null ? '' : node.alt);
            // 只认 Crepe 自己写出来的那个形状（1.00 / 0.75，两位小数、10 倍以内），
            // 免得把 ![2026](chart.png) 这种数字图注当成缩放比例吃掉
            const num = Number(raw);
            const isRatio = /^\d+\.\d{2}$/.test(raw) && num > 0 && num <= 10;
            state.addNode(type, {
              src: node.url,
              caption: node.title || '',
              ratio: isRatio ? num : 1,
              alt: isRatio ? '' : raw,
            });
          },
        },
        toMarkdown: {
          match: s.toMarkdown.match,
          runner: (state, node) => {
            const r = Number.parseFloat(node.attrs.ratio);
            // 有图注写图注；没图注且被缩放过才写比例，免得给 ![](url) 平白塞个 1.00
            const alt = node.attrs.alt || (Number.isFinite(r) && r !== 1 ? r.toFixed(2) : '');
            state.openNode('paragraph');
            state.addNode('image', undefined, undefined, {
              title: node.attrs.caption,
              url: node.attrs.src,
              alt,
            });
            state.closeNode();
          },
        },
      };
    });
  });
}

// 富文本编辑器里点「/image」浏览本地文件插入图片：Crepe 默认给的 onUpload 是
// `URL.createObjectURL(file)`——图能看见但不是真文件，重开就裂。这里换成调用方（app.js）
// 传进来的落盘函数，选完文件直接存到 md 同目录，返回真实绝对路径。
function imageFeatureConfigs(saveFn) {
  return {
    [Crepe.Feature.ImageBlock]: {
      onUpload: (file) => saveFn(file, file.name),
    },
  };
}

// 生成不会跟真实 markdown 图片路径冲突的占位符——落盘完成前，节点的 src 先顶这个字符串，
// 靠 attrs.src 精确匹配回填，不用记 DOM 位置（位置会随文档变动漂移）。
let pendingSeq = 0;
function nextPendingId() { return `pending-upload:${++pendingSeq}-${Date.now()}`; }

// 粘贴的 HTML 里已经带 <img src="blob:...">/<img src="data:image/...">（比如从 fanbox 自己的
// 截图/马赛克工具复制）：这类 URL 只在当次会话有效，原样落进文档下次打开就裂图。
// 在 ProseMirror 把 HTML 解析成 slice 之前先把 src 换成占位符，图片字节异步转存真文件后再回填。
function rewritePendingImgSrc(html, saveFn, getView) {
  if (!/src=["'](blob:|data:image)/i.test(html)) return html;
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('img[src^="blob:"], img[src^="data:image"]').forEach((img) => {
    const original = img.getAttribute('src');
    const id = nextPendingId();
    img.setAttribute('src', id);
    resolvePendingImg(id, original, saveFn, getView);
  });
  return tpl.innerHTML;
}

async function resolvePendingImg(id, original, saveFn, getView) {
  try {
    const res = await fetch(original);
    const blob = await res.blob();
    const path = await saveFn(blob, null);
    const view = getView();
    if (!view) return;
    let tr = view.state.tr;
    let changed = false;
    view.state.doc.descendants((node, pos) => {
      if ((node.type.name === 'image' || node.type.name === 'image-block') && node.attrs.src === id) {
        tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: path });
        changed = true;
      }
    });
    if (changed) view.dispatch(tr);
  } catch (err) {
    console.error('[fanbox] 粘贴图片转存失败', err);
    if (typeof window.toast === 'function') window.toast('粘贴图片转存失败：' + (err.message || err), true);
    // 转存失败别把占位符字符串留在文档里当死链接——直接摘掉这张图，比留一个假路径更安全
    const view = getView();
    if (!view) return;
    let tr = view.state.tr;
    let changed = false;
    view.state.doc.descendants((node, pos) => {
      if ((node.type.name === 'image' || node.type.name === 'image-block') && node.attrs.src === id) {
        tr = tr.delete(tr.mapping.map(pos), tr.mapping.map(pos + node.nodeSize));
        changed = true;
      }
    });
    if (changed) view.dispatch(tr);
  }
}

// 真实剪贴板图片（截图工具粘贴，clipboardData 里是 image/* 的 File）+ Finder 拖文件到编辑区：
// Crepe/Milkdown 自带的剪贴板插件只读 text/plain、text/html，压根不看 clipboardData.files/
// dataTransfer.files，这两种情况今天完全没反应。@milkdown/plugin-upload 同时实现了
// handlePaste（读 clipboardData.files）和 handleDrop（读 dataTransfer.files），接上就有了。
function configureImageUpload(editor, saveFn) {
  editor.use(upload);
  editor.config((ctx) => {
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      uploader: async (files, schema, uctx) => {
        // 这个 uploader 绝不能抛出：@milkdown/plugin-upload 拿到 reject 只会 console.error，
        // 「Upload in progress...」占位符没人清，会永远卡在文档里。每个文件单独兜底，
        // 存失败就跳过 + toast，不连累同批里存成功的图。
        const nodes = [];
        for (const f of Array.from(files)) {
          if (!f.type || !f.type.startsWith('image/')) continue;
          try {
            const src = await saveFn(f, f.name);
            nodes.push(imageBlockSchema.type(uctx).create({ src, alt: '' }));
          } catch (err) {
            console.error('[fanbox] 图片写盘失败', err);
            if (typeof window.toast === 'function') window.toast('图片写盘失败：' + (err.message || err), true);
          }
        }
        return nodes;
      },
    }));
    // 拦截粘贴 HTML 里已经带 blob:/data: 的 <img>（见 rewritePendingImgSrc）。挂在
    // transformPastedHTML 而不是 handlePaste：ProseMirror 的粘贴管线先跑 transformPastedHTML
    // 生成 slice，再把结果交给各插件的 handlePaste——Crepe 自己的 handlePaste 一看 html 非空
    // 就直接用这个预处理过的 slice 提交，写在 handlePaste 里必然抢不到。Crepe 自己对这个钩子
    // 用的也是「包一层调用 prev」的组合写法，所以这里不管注册顺序都安全。
    ctx.update(editorViewOptionsCtx, (prev) => ({
      ...prev,
      transformPastedHTML: (html, view) => {
        const base = prev.transformPastedHTML ? prev.transformPastedHTML(html, view) : html;
        return rewritePendingImgSrc(base, saveFn, () => view);
      },
    }));
  });
}

// 文档内拖图片重排：Crepe 自带的 block-handle 是 Notion 式左侧悬浮把手（block-edit 功能），
// 但它没传 root 给 floating-ui provider，实际挂载在 .crepe-host 内部而非 portal 到 body，
// 又只有 flip() 没有 shift() 中间件——FanBox 的编辑区左内边距完全不够它的定位空间，
// 挪不出来就等于看不见摸不着。不修这条路，直接在每张图自己的框里塞常驻的上移/下移按钮：
// 定位相对图片自己的盒子，不依赖任何浮层定位，不会被滚动容器裁切。
function addImageMoveControls(editor) {
  editor.use($prose(() => new Plugin({
    view(view) { return new ImageMoveView(view); },
  })));
}

class ImageMoveView {
  constructor(view) {
    this.view = view;
    this.update(view);
  }
  update(view) {
    this.view = view;
    // 不拿外部 Map 记 pos -> 控件：image-block 是 Crepe 自己的组件化 NodeView，重排/属性变化后
    // 经常把这个节点的 DOM 整个换掉（实测踩到过——换位一次后控件消失，因为 Map 里存的还是
    // 挂在旧 DOM 上、已经从文档里摘掉的引用）。改成每次 update 都直接问「这个节点当前的真实 DOM
    // 自己有没有控件」，DOM 本身就是唯一事实源，天然跟着 Crepe 的重渲染走，没有缓存失配的余地。
    view.state.doc.descendants((node, pos) => {
      if (node.type.name !== 'image-block') return;
      const dom = view.nodeDOM(pos);
      if (!dom || !(dom instanceof HTMLElement)) return;
      let ctl = dom.querySelector(':scope > .fanbox-img-move');
      if (!ctl) {
        ctl = document.createElement('div');
        ctl.className = 'fanbox-img-move';
        ctl.innerHTML = '<button type="button" data-dir="-1" title="上移">↑</button><button type="button" data-dir="1" title="下移">↓</button>';
        if (!dom.style.position) dom.style.position = 'relative';
        dom.appendChild(ctl);
        ctl.addEventListener('mousedown', (ev) => ev.preventDefault()); // 别抢走编辑器的选区/焦点
        ctl.addEventListener('click', (ev) => {
          const btn = ev.target.closest('button');
          if (!btn) return;
          ev.preventDefault();
          ev.stopPropagation();
          moveTopLevelSibling(this.view, Number(ctl.dataset.pos), Number(btn.dataset.dir));
        });
      }
      ctl.dataset.pos = String(pos); // 每次 update 刷新成最新位置，点击时读的是当次最新值
    });
  }
  destroy() {
    // 不用清理：控件是挂在 Crepe 渲染出的节点 DOM 上的子元素，节点从文档里摘掉时随整棵子树一起
    // 被移除，没有外部持有的引用需要释放
  }
}

// 标准 ProseMirror 手法：删掉当前节点，用 mapping 把「相邻同级节点原本的起点」换算成
// 删除后的新坐标，再插回去——比直接 swap 两段内容更不容易在边界（首/尾子节点）出错。
// pos 是 doc.descendants() 直接给的「节点起点」，不用再拿 $pos.before() 换算——image-block
// 是文档的顶层子节点（深度 0），$pos.before() 在深度 0 会直接抛 RangeError（没有「顶层节点之前
// 的位置」这回事，测试时实测踩到了），pos 本身已经是正确的绝对坐标。
function moveTopLevelSibling(view, pos, dir) {
  const { state } = view;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  const index = $pos.index();
  const targetIndex = index + dir;
  if (targetIndex < 0 || targetIndex >= parent.childCount) return;
  const node = parent.child(index);
  const start = pos;
  const end = start + node.nodeSize;
  const sibling = parent.child(targetIndex);
  // 上移：插回「相邻节点原本的起点」（sibling 在 start 之前，删除不影响它的坐标，直接用）。
  // 下移：插到「相邻节点原本的终点」之后（sibling 在 end 之后，删除后整体前移 node.nodeSize，
  // 靠 mapping 换算）——这里曾经写成 sibling 的起点，效果是插回原处不动，下移点了没反应，实测才发现。
  const targetBoundary = dir < 0 ? (start - sibling.nodeSize) : (end + sibling.nodeSize);
  let tr = state.tr.delete(start, end);
  const insertPos = tr.mapping.map(targetBoundary, dir < 0 ? -1 : 1);
  tr.insert(insertPos, node);
  view.dispatch(tr.scrollIntoView());
}

// 工具栏「插入图片」按钮用：文件已经落盘拿到真实路径后，插到当前光标位置。
// replaceSelectionWith 是标准手法——光标是插入点就插在那，选中一段内容就把它换成图片。
function insertImageAtCursor(editor, src) {
  editor.action((ctx) => {
    const view = ctx.get(editorViewCtx);
    const node = imageBlockSchema.type(ctx).create({ src, alt: '' });
    const tr = view.state.tr.replaceSelectionWith(node);
    view.dispatch(tr.scrollIntoView());
    view.focus();
  });
}

window.FanboxCrepe = {
  Crepe, keepImageAlt, imageFeatureConfigs, configureImageUpload, addImageMoveControls, insertImageAtCursor,
};
