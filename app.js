console.log("✅ script.js 読み込まれました！");

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

let drawing = false;
let lassoMode = false;
let lassoStart = null;
let lassoEnd = null;
let penSize = 2;
let penColor = '#000000';
let paths = [];
let undoStack = [];
let redoStack = [];
let currentPath = [];
let startTime = 0;
let selectedStrokes = new Set();
let altPressed = false;
// タイムライン用：描画済みストロークの座標キャッシュ & 投げ縄座標
let timelineLayout = [];  // [{ index, id, active, points:[{x,y}], bbox:{minX,minY,maxX,maxY} }, ...]
let timelineLassoStart = null;
let timelineLassoEnd   = null;

const penBtn = document.getElementById('pen');
const colorPicker = document.getElementById('colorPicker');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');
const sizeSlider = document.getElementById('size');
const lassoBtn = document.getElementById('lasso');
const toggleStrokeListBtn = document.getElementById('toggleStrokeListBtn');
const strokeListEl = document.getElementById('strokeList');
const INACTIVE_ALPHA_WHEN_ALT = 0.15; // Alt中に非表示ストロークをどれくらい薄く描くか
// タイムラインの投げ縄は非表示ストロークも常に選択対象にする
const TIMELINE_LASSO_INCLUDES_INACTIVE = true;

const showInactiveBtn = document.getElementById('showInactiveBtn');
let showInactive = false; // ← iPad用トグル

const timelineCanvas = document.getElementById('timelineCanvas');
const tl = timelineCanvas.getContext('2d');

const DB_NAME = 'SketchAppDB';
const STORE_NAME = 'snapshots';
const PATHS_RECORD_ID = 'paths';
const DB_VERSION = 1;
let db;

const openDB = () => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);

  request.onupgradeneeded = e => {
    db = e.target.result;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      db.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };

  request.onsuccess = () => {
    db = request.result;
    listSnapshots();
    loadAllPathsFromDB();    // ← ① まずストロークデータを復元
    loadLatestSnapshot();    // ← ② 次に最新スナップショットの active 状態だけ適用
  };

  request.onerror = e => {
    console.error('IndexedDB open error:', e.target.errorCode);
  };
};

openDB();

const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');

exportBtn.addEventListener('click', exportAllData);
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', handleImportFile);

/**
 * 全ストローク情報（paths 配列）を IndexedDB に保存する
 */
function saveAllPathsToDB() {
  if (!db) return;  
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    id: PATHS_RECORD_ID,
    // paths 配列を深いコピーして保存
    paths: paths.map(p => ({ ...p }))
  });
  tx.oncomplete = () => {
    // 必要ならここで何かログ出力
    console.log('saveAllPathsToDB: paths saved');
  };
  tx.onerror = e => {
    console.error('saveAllPathsToDB error:', e.target.error);
  };
}

// ドラッグがごく小さい（タップ相当）場合はラッソ選択として扱わない
const LASSO_MIN_PX = 6;
function isSmallRect(p1, p2) {
  return !p1 || !p2 ||
    (Math.abs(p2.x - p1.x) < LASSO_MIN_PX && Math.abs(p2.y - p1.y) < LASSO_MIN_PX);
}


async function exportAllData() {
  // 1) paths レコード
  const tx1 = db.transaction([STORE_NAME], 'readonly');
  const store1 = tx1.objectStore(STORE_NAME);
  const pathsRec = await new Promise(resolve => {
    const req = store1.get(PATHS_RECORD_ID);
    req.onsuccess = () => resolve(req.result || { id: PATHS_RECORD_ID, paths: [] });
  });

  // 2) snapshot レコード（prefix が snapshot- の全件）
  const tx2 = db.transaction([STORE_NAME], 'readonly');
  const store2 = tx2.objectStore(STORE_NAME);
  const allRecs = await new Promise(resolve => {
    const req = store2.getAll();
    req.onsuccess = () => resolve(req.result);
  });
  const snaps = allRecs.filter(r => r.id.startsWith('snapshot-'));

  // 3) JSON 化
  const exportObj = {
    paths: pathsRec.paths,
    snapshots: snaps.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      activeIndexes: r.activeIds,
      preview: r.preview
    }))
  };
  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  // 4) ダウンロード用リンクを自動クリック
  const a = document.createElement('a');
  a.href = url;
  a.download = `sketch-data-${new Date().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const imported = JSON.parse(reader.result);

      // ① 単一のトランザクションで store を開き、全レコードをクリア
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // clear() はリクエストなので、完了を待つ
      await new Promise(resolve => {
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve();
      });

      // ② paths レコードを完全上書き
      store.put({
        id: PATHS_RECORD_ID,
        paths: imported.paths || []
      });

      // ③ snapshots レコードを完全上書き（既存はクリア済み）
      (imported.snapshots || []).forEach(snap => {
        const ids = Array.isArray(snap.activeIds)
     ? snap.activeIds
     : Array.isArray(snap.activeIndexes)
       ? snap.activeIndexes
       : [];
   store.put({
     id:        snap.id,
     timestamp: snap.timestamp,
     activeIds: ids,           // ← 必ず activeIds に統一して保存
     preview:   snap.preview
        });
      });

      // ④ トランザクション完了を待って UI を更新
      await tx.complete;
      loadAllPathsFromDB();
      listSnapshots();
      loadLatestSnapshot();

      alert('インポート完了：全データをファイル内容で上書きしました。');
    } catch (e) {
      console.error(e);
      alert('インポート中にエラーが発生しました');
    }
  };
  reader.readAsText(file);
}

function generateStrokeId() {
  // Date.now()＋ランダム文字列でほぼ衝突しない ID
  return 'stroke-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}




penBtn.addEventListener('click', () => {
  lassoMode = false;
  selectedStrokes.clear();
  redraw();
  updateStrokeList();
});


sizeSlider.addEventListener('input', (e) => {
  penSize = parseInt(e.target.value);
});
colorPicker.addEventListener('input', (e) => {
  penColor = e.target.value;
});
lassoBtn.addEventListener('click', () => {
  lassoMode = !lassoMode;
  selectedStrokes.clear();
  redraw();
  updateStrokeList();
});

window.addEventListener('keydown', e => {
  if (e.key === 'Alt') {
    altPressed = true;
    redraw();
    updateStrokeList();
  }
});
window.addEventListener('keyup', e => {
  if (e.key === 'Alt') {
    altPressed = false;
    redraw();
    updateStrokeList();
  }
});

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

canvas.addEventListener('mousedown', (e) => {
  if (lassoMode) {
    lassoStart = getMousePos(e);
    lassoEnd = null;
  } else {
    drawing = true;
    startTime = Date.now();
    const pos = getMousePos(e);
    currentPath = [{ x: pos.x, y: pos.y, tAbs: performance.now() }];
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (lassoMode && lassoStart) {
    lassoEnd = getMousePos(e);
    redraw();
    return;
  }
  if (!drawing) return;
  const pos = getMousePos(e);
  currentPath.push({ x: pos.x, y: pos.y, tAbs: performance.now() });

  ctx.lineWidth = penSize;
  ctx.lineCap = 'round';
  ctx.strokeStyle = penColor;
  const len = currentPath.length;
  if (len >= 2) {
    const p1 = currentPath[len - 2];
    const p2 = currentPath[len - 1];
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
});

canvas.addEventListener('mouseup', (e) => {
  // ★ ラッソモード中はストローク確定を絶対に行わない
  if (lassoMode) {
    if (lassoStart && lassoEnd && !isSmallRect(lassoStart, lassoEnd)) {
      selectStrokesInLasso(lassoStart, lassoEnd);
    }
    // 状態クリア（次のタップで誤確定しないように）
    lassoStart = null;
    lassoEnd = null;
    drawing = false;
    currentPath = [];
    updateStrokeList();
    redraw();
    return;
  }

  // ここからペンモード時のみ
  const endTime = Date.now();
  if (drawing && currentPath.length > 1) {
    const duration = endTime - startTime;

    const startAbs = currentPath[0].tAbs ?? performance.now();
    const endAbs   = currentPath.at(-1).tAbs ?? (startAbs + duration);

    const length   = calcLength(currentPath);
    const speed    = length / Math.max(1, duration);

    const stroke = {
      id:        generateStrokeId(),
      points:    currentPath,
      size:      penSize,
      color:     penColor,
      startTime, endTime,
      duration,  length,
      speed,
      active:    true,
      startTimeAbs: startAbs,
      endTimeAbs:   endAbs
    };
    paths.push(stroke);
    redoStack = [];
    updateStrokeList();
    saveAllPathsToDB();
  }

  drawing = false;
});


canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
  canvas.dispatchEvent(new MouseEvent('mousedown', fakeEvent));
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const touch = e.touches[0];
  const fakeEvent = { clientX: touch.clientX, clientY: touch.clientY };
  canvas.dispatchEvent(new MouseEvent('mousemove', fakeEvent));
});

canvas.addEventListener('touchend', (e) => {
  e.preventDefault();
  canvas.dispatchEvent(new MouseEvent('mouseup', {}));
});


function selectStrokesInLasso(p1, p2) {
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);

  selectedStrokes.clear();
  const revealInactive = altPressed || showInactive; // ★ここで論理和

  paths.forEach((path, i) => {
    if (!path.active && !revealInactive) return;

    for (const pt of path.points) {
      if (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY) {
        selectedStrokes.add(i);
        break;
      }
    }
  });
}


function calcLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    len += Math.sqrt(dx * dx + dy * dy);
  }
  return len;
}

function drawTimeline() {
if (!timelineCanvas || !tl) return;

  const dpr = window.devicePixelRatio || 1;
  let cssW = timelineCanvas.clientWidth;
  const cssH = timelineCanvas.clientHeight;
  
  // ★ cssW を 200px に制限
  cssW = Math.min(cssW, 200);
  
  if (timelineCanvas.width !== Math.floor(cssW * dpr) ||
      timelineCanvas.height !== Math.floor(cssH * dpr)) {
    timelineCanvas.width  = Math.floor(cssW * dpr);
    timelineCanvas.height = Math.floor(cssH * dpr);
    tl.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  tl.clearRect(0, 0, cssW, cssH);

  const visible = paths.filter(s => s.points && s.points.length >= 2);
  if (visible.length === 0 || !paths.length) return;

  // === ギャップ圧縮レイアウト計算（既存） ===
  const basis = [...paths].sort((a,b) => {
    const aStart = (a.startTime ?? a.startTimeAbs ?? a.points?.[0]?.tAbs ?? 0);
    const bStart = (b.startTime ?? b.startTimeAbs ?? b.points?.[0]?.tAbs ?? 0);
    return aStart - bStart;
  });

  const offsets = new Map();
  let cum = 0;
  for (const s of basis) {
    const s0 = s.startTimeAbs ?? s.points?.[0]?.tAbs ?? s.startTime ?? 0;
    const sN = s.endTimeAbs   ?? s.points?.[s.points.length-1]?.tAbs ?? s.endTime ?? s0;
    const dur = Math.max(1, sN - s0);
    offsets.set(s, cum);
    cum += dur;
  }
  const totalDrawMs = Math.max(1, cum);

  const xOf = (x) => (x / canvas.width) * cssW;
  const yOfPoint = (s, tAbs) => {
    const s0 = s.startTimeAbs ?? s.points?.[0]?.tAbs ?? s.startTime ?? 0;
    const base = offsets.get(s) || 0;
    const local = Math.max(0, (tAbs ?? s0) - s0);
    const compactT = base + local;
    return (compactT / totalDrawMs) * cssH;
  };

  // 背景ガイド
  tl.save();
  tl.strokeStyle = '#cfcfcf';
  tl.lineWidth = 1;
  for (let k = 0; k <= 5; k++) {
    const y = (k / 5) * cssH;
    tl.beginPath(); tl.moveTo(0, y); tl.lineTo(cssW, y); tl.stroke();
  }
  tl.restore();

  // === ここでタイムライン座標をキャッシュ ===
  timelineLayout = [];
  for (const s of visible) {
    const pts = s.points;
    if (!pts || pts.length < 2) continue;

    const mapped = pts.map(p => ({ x: xOf(p.x), y: yOfPoint(s, p.tAbs) }));
    // bbox
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const q of mapped) {
      if (q.x < minX) minX = q.x;
      if (q.y < minY) minY = q.y;
      if (q.x > maxX) maxX = q.x;
      if (q.y > maxY) maxY = q.y;
    }
    timelineLayout.push({
      index: paths.indexOf(s),
      id: s.id,
      active: !!s.active,
      points: mapped,
      bbox: { minX, minY, maxX, maxY }
    });
  }

  // === 実描画（既存と同様） ===
for (const s of visible) {
  const pts = s.points;
  if (!pts || pts.length < 2) continue;

  const isSelected = selectedStrokes.has(paths.indexOf(s));
  tl.save();
  tl.lineWidth = 2;
  tl.globalAlpha = s.active ? 1.0 : 0.10;
  tl.strokeStyle = s.color || '#111';
  tl.lineJoin = 'round';
  tl.lineCap = 'round';

  // ★ 追加: 選択されたストロークは点線にする
  if (isSelected) {
    tl.setLineDash([6, 4]);   // [線の長さ, 間隔]
  } else {
    tl.setLineDash([]);       // 通常は実線
  }

  tl.beginPath();
  tl.moveTo(xOf(pts[0].x), yOfPoint(s, pts[0].tAbs));
  for (let j = 1; j < pts.length; j++) {
    tl.lineTo(xOf(pts[j].x), yOfPoint(s, pts[j].tAbs));
  }
  tl.stroke();
  tl.restore();
}


  // 注記など（省略可）

  // === タイムラインの投げ縄矩形をオーバーレイ ===
  if (lassoMode && timelineLassoStart && timelineLassoEnd) {
    tl.save();
    tl.setLineDash([5, 3]);
    tl.strokeStyle = 'rgba(0,0,255,0.5)';
    tl.lineWidth = 1;
    tl.strokeRect(
      Math.min(timelineLassoStart.x, timelineLassoEnd.x),
      Math.min(timelineLassoStart.y, timelineLassoEnd.y),
      Math.abs(timelineLassoEnd.x - timelineLassoStart.x),
      Math.abs(timelineLassoEnd.y - timelineLassoStart.y)
    );
    tl.restore();
  }
}


function redraw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  paths.forEach((path, i) => {
    const isSelected = selectedStrokes.has(i);
    const isInactive = !path.active;
    const revealInactive = altPressed || showInactive; // ← 追加

    // 非アクティブは「Alt or ボタン」がOFF かつ 非選択なら描かない
    if (isInactive && !revealInactive && !isSelected) return;

    ctx.save();

    // 選択は点線
    ctx.setLineDash(isSelected ? [6, 4] : []);

    // 薄さ：非アクティブは下げる（数値は好みで調整OK）
    if (isInactive) {
      // 選択中は少し濃いめ、未選択はかなり薄く
      ctx.globalAlpha = isSelected ? 0.15 : 0.15;
    } else {
      ctx.globalAlpha = 1.0;
    }

    ctx.strokeStyle = path.color;
    ctx.lineWidth   = path.size;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    const pts = path.points;
    if (pts && pts.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    ctx.restore();
  });

  // 既存のラッソ矩形・タイムライン描画はそのまま
  if (lassoMode && lassoStart && lassoEnd) {
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = 'rgba(0,0,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(lassoStart.x, lassoEnd.x),
      Math.min(lassoStart.y, lassoEnd.y),
      Math.abs(lassoEnd.x - lassoStart.x),
      Math.abs(lassoEnd.y - lassoStart.y)
    );
    ctx.restore();
  }

  drawTimeline();
}


showInactiveBtn.addEventListener('click', () => {
  showInactive = !showInactive;
  showInactiveBtn.classList.toggle('active', showInactive);
  showInactiveBtn.setAttribute('aria-pressed', String(showInactive));
  redraw();
  updateStrokeList(); // （リスト側の強調があるなら）
});






function toggleActive(index) {
  // ① 状態を反転
  paths[index].active = !paths[index].active;

  // ② 画面とリストを更新
  updateStrokeList();   // リスト側を再生成
  redraw();             // キャンバス側を再描画

  // ③ IndexedDB に保存
  saveAllPathsToDB();
}

function updateStrokeList() {
  const list = document.getElementById('strokeList');
  list.innerHTML = ''; 

  paths.forEach((path, i) => {
    const div = document.createElement('div');
    div.className = 'stroke-entry';
    if (selectedStrokes.has(i)) {
      div.style.backgroundColor = '#ffffcc';
    }

    // startTime を日付文字列に変換
    const ts = new Date(path.startTime).toLocaleString();

    // info 部分をタイムスタンプに置き換え
    const info = document.createElement('div');
    info.innerHTML = `
      ${ts} — ${path.duration}ms, ${path.length.toFixed(1)}px, ${path.speed.toFixed(2)}px/ms
      <label>
        <input type="checkbox" ${path.active ? 'checked' : ''} onchange="toggleActive(${i})">
        Active
      </label>
    `;

    // プレビュー用キャンバス
    const preview = document.createElement('canvas');
    preview.width = 100;
    preview.height = 50;
    preview.style.border = '1px solid #ccc';
    drawPreview(preview, path);

    div.appendChild(info);
    div.appendChild(preview);
    list.appendChild(div);
  });

  redraw();
}


function loadAllPathsFromDB() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(PATHS_RECORD_ID);
  req.onsuccess = () => {
    if (req.result) {
        paths = req.result.paths.map(p => {
    // 旧データ補完：points の各点に tAbs が無ければ均等割で付与
    if (Array.isArray(p.points) && p.points.length >= 2 && !p.points[0].tAbs) {
      const startAbs = performance.now();
      const dur = Math.max(1, p.duration || 1);
      p.points = p.points.map((pt, idx) => ({
        x: pt.x, y: pt.y,
        tAbs: startAbs + (dur * idx / (p.points.length - 1))
      }));
      p.startTimeAbs = startAbs;
      p.endTimeAbs = startAbs + dur;
    }
    return { ...p };
  });
      updateStrokeList();
      redraw();
    }
  };
}

undoBtn.addEventListener('click', () => {
  if (paths.length > 0) {
    redoStack.push(paths.pop());
    updateStrokeList();
  }
});
redoBtn.addEventListener('click', () => {
  if (redoStack.length > 0) {
    paths.push(redoStack.pop());
    updateStrokeList();
  }
});



function saveSnapshot() {
  if (!db) return;
  const id = `snapshot-${Date.now()}`;
  const preview = canvas.toDataURL();
  const activeIds = paths.filter(p => p.active).map(p => p.id);

  // ① スナップショット用トランザクションを作成
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  // ② スナップショットレコードを保存
  store.put({
    id,
    timestamp: new Date().toISOString(),
    activeIds,
    preview
  });

  // ③ トランザクション完了時のハンドラ
  tx.oncomplete = () => {
    // paths も最新状態を保存
    saveAllPathsToDB();
    // 一覧を更新してアラートを出す
    listSnapshots();
    alert('スナップショットが保存されました！');
  };

  // エラー時のハンドラ（念のため）
  tx.onerror = e => {
    console.error('saveSnapshot transaction error:', e.target.error);
    alert('スナップショットの保存に失敗しました');
  };
}

function loadSnapshotById(snapshotId) {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(snapshotId);

  req.onsuccess = () => {
    const snap = req.result;
    if (!snap || !Array.isArray(snap.activeIds)) return;
    // まず全ストローク非アクティブ化
    paths.forEach(p => p.active = false);
    // ID が一致するものだけアクティブに
    snap.activeIds.forEach(id => {
      const p = paths.find(path => path.id === id);
      if (p) p.active = true;
    });
    updateStrokeList();
    redraw();
  };
}



clearBtn.addEventListener('click', () => {
  saveSnapshot();
  paths.forEach(path => path.active = false);
  redoStack = [];
  updateStrokeList();
  redraw();
});

function drawPreview(canvas, path) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const points = path.points;
  if (points.length < 2) return;
  const bounds = getBounds(points);
  const scaleX = canvas.width / (bounds.maxX - bounds.minX + 1);
  const scaleY = canvas.height / (bounds.maxY - bounds.minY + 1);
  const scale = Math.min(scaleX, scaleY);
  ctx.lineWidth = path.size * scale;
  ctx.lineCap = 'round';
  ctx.strokeStyle = path.color;
  ctx.beginPath();
  for (let i = 1; i < points.length; i++) {
    const p1 = points[i - 1];
    const p2 = points[i];
    ctx.moveTo((p1.x - bounds.minX) * scale, (p1.y - bounds.minY) * scale);
    ctx.lineTo((p2.x - bounds.minX) * scale, (p2.y - bounds.minY) * scale);
  }
  ctx.stroke();
}

function getBounds(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  points.forEach(p => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  });
  return { minX, minY, maxX, maxY };
}



function loadSnapshot() {
  if (!db) return;
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.get('latest');
  request.onsuccess = function () {
    if (request.result) {
      paths = request.result.paths;
      redoStack = [];
      updateStrokeList();
      redraw();
      console.log("スナップショットを読み込みました");
    }
  };
  request.onerror = function (e) {
    console.error("読み込み失敗:", e.target.errorCode);
  };
}

function listSnapshots() {
  if (!db) return;

  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();

  request.onsuccess = function () {
    const list = document.getElementById('snapshotList');
    list.innerHTML = '';

    const snaps = request.result.filter(r => r.id.startsWith('snapshot-'));
    snaps.forEach(snapshot => {
      const div = document.createElement('div');
      div.style.marginBottom = '10px';

      // プレビュー画像
      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.width = 200
      img.height = 135;
      img.style.border = '1px solid #ccc';

      // ホバー時に表示されるツールチップ
      const ts = new Date(snapshot.timestamp).toLocaleString();
      img.title = ts;   // ←ここだけでOK

      img.addEventListener('click', () => loadSnapshotById(snapshot.id));

      div.appendChild(img);
      list.appendChild(div);
    });
  };
}



function loadLatestSnapshot() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const getAllReq = store.getAll();
  getAllReq.onsuccess = () => {
    const snaps = getAllReq.result.filter(s => s.id.startsWith('snapshot-'));
    if (snaps.length === 0) return;
    const latest = snaps.sort(
      (a, b) => new Date(b.timestamp) - new Date(a.timestamp)
    )[0];
    loadSnapshotById(latest.id);
  };
}

toggleStrokeListBtn.addEventListener('click', () => {
  if (strokeListEl.style.display === 'none' || strokeListEl.style.display === '') {
    strokeListEl.style.display = 'block';
  } else {
    strokeListEl.style.display = 'none';
  }
});

saveBtn.addEventListener('click', () => {
  saveSnapshot();
});

document.getElementById('toggleSelectedBtn').addEventListener('click', () => {
  selectedStrokes.forEach(index => {
    paths[index].active = !paths[index].active;
  });
  updateStrokeList();
});

function getMousePosOnTimeline(e) {
  const rect = timelineCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
}

function selectStrokesInTimelineLasso(p1, p2) {
  if (!timelineLayout || timelineLayout.length === 0) return;

  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);

  const inRect = (pt) => (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY);

  selectedStrokes.clear();
  for (const item of timelineLayout) {
    // ALT未押下なら active のみを対象にする（キャンバス側の仕様に合わせる）
    if (!item.active && !TIMELINE_LASSO_INCLUDES_INACTIVE && !altPressed) continue;

    // まずバウンディングボックスで粗く判定
    const b = item.bbox;
    const bboxOverlap =
      !(b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY);
    if (!bboxOverlap) continue;

    // 1点でも矩形に入れば選択
    let hit = false;
    for (const pt of item.points) {
      if (inRect(pt)) { hit = true; break; }
    }
    if (hit) selectedStrokes.add(item.index);  // 既存どおり index ベース
  }
}

timelineCanvas.addEventListener('mousedown', (e) => {
  if (!lassoMode) return;  // ペンモード時は無視（必要ならペン描画もタイムラインに実装可）
  timelineLassoStart = getMousePosOnTimeline(e);
  timelineLassoEnd = null;
  drawTimeline();
});

timelineCanvas.addEventListener('mousemove', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);
  drawTimeline(); // 矩形の見た目を更新
});

timelineCanvas.addEventListener('mouseup', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);

  // ドラッグが小さい＝タップ相当は無視（選択しない）
  if (isSmallRect(timelineLassoStart, timelineLassoEnd)) {
    timelineLassoStart = null;
    timelineLassoEnd = null;
    drawTimeline();
    return;
  }

  selectStrokesInTimelineLasso(timelineLassoStart, timelineLassoEnd);

  // 状態クリア & 反映
  timelineLassoStart = null;
  timelineLassoEnd = null;

  updateStrokeList();
  redraw();
});


// すでにある変数: penBtn, lassoBtn, lassoMode, selectedStrokes などを利用

// 1) モードの見た目とARIAを更新する関数
function updateModeUI() {
  const penActive   = !lassoMode;
  const lassoActive =  lassoMode;

  penBtn.classList.toggle('is-active', penActive);
  lassoBtn.classList.toggle('is-active', lassoActive);

  // アクセシビリティ（トグルボタンの状態を支援技術へ伝える）
  penBtn.setAttribute('aria-pressed', String(penActive));
  lassoBtn.setAttribute('aria-pressed', String(lassoActive));
}

// 2) モードをまとめて切り替える関数（状態＋UI＋再描画）
function setMode(mode) {
  lassoMode = (mode === 'lasso');
  selectedStrokes.clear();

  // ★ ラッソ⇔ペン切替時に入力状態を完全リセット
  drawing = false;
  currentPath = [];

  lassoStart = null;
  lassoEnd = null;

  timelineLassoStart = null;
  timelineLassoEnd = null;

  updateModeUI();
  redraw();
  updateStrokeList();
}


// ── iPad向け：タイムラインのタッチ操作（ラッソ）を有効化 ──
timelineCanvas.addEventListener('touchstart', (e) => {
  if (!lassoMode) return;
  e.preventDefault();
  const t = e.touches[0];
  timelineLassoStart = getMousePosOnTimeline(t);
  timelineLassoEnd = null;
  drawTimeline();
}, { passive: false });

timelineCanvas.addEventListener('touchmove', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  e.preventDefault();
  const t = e.touches[0];
  timelineLassoEnd = getMousePosOnTimeline(t);
  drawTimeline();
}, { passive: false });

timelineCanvas.addEventListener('touchend', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  e.preventDefault();

  // ドラッグが小さい＝タップ相当は無視（選択しない）
  if (isSmallRect(timelineLassoStart, timelineLassoEnd)) {
    timelineLassoStart = null;
    timelineLassoEnd = null;
    drawTimeline();
    return;
  }

  if (timelineLassoEnd) {
    selectStrokesInTimelineLasso(timelineLassoStart, timelineLassoEnd);
  }

  timelineLassoStart = null;
  timelineLassoEnd = null;

  // 念のため：キャンバス側の描画入力は無効化しておく
  drawing = false;
  currentPath = [];

  updateStrokeList();
  redraw();
}, { passive: false });

timelineCanvas.addEventListener('touchcancel', () => {
  timelineLassoStart = null;
  timelineLassoEnd = null;
  drawTimeline();
}, { passive: false });



// 3) 既存のクリックハンドラを置き換え/修正
penBtn.addEventListener('click', () => {
  setMode('pen');
});

lassoBtn.addEventListener('click', () => {
  // 連打でトグルしたいなら以下でもOK：
  // setMode(lassoMode ? 'pen' : 'lasso');
  setMode('lasso');
});

// 4) 初期呼び出し（起動時に正しい見た目へ）
updateModeUI();

// （任意）キーボードショートカット：V=ペン / L=投げ縄
window.addEventListener('keydown', (e) => {
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) return; // 入力中は無視
  if (e.key === 'v' || e.key === 'V') setMode('pen');
  if (e.key === 'l' || e.key === 'L') setMode('lasso');
});


function syncTimelineSize() {
  // 左キャンバスの CSS 高さに合わせる
  timelineCanvas.style.height = canvas.clientHeight + 'px';
  drawTimeline();
}
window.addEventListener('resize', syncTimelineSize);
setTimeout(syncTimelineSize, 0);


window.toggleActive = toggleActive;