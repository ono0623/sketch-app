console.log("✅ app.js 読み込まれました！");

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const timelineCanvas = document.getElementById('timelineCanvas');
const tl = timelineCanvas.getContext('2d');

// 変数宣言

let drawing = false;
let lassoMode = false;
let lassoStart = null;
let lassoEnd = null;
let penSize = 2;

let viewOffset = { x: 0, y: 0 };      // 視点（カメラ）オフセット（世界座標→画面座標用）
let isPanning = false;                // Space+ドラッグでのパン中かどうか
let panStartMouse = null;             // パン開始時のマウス位置（画面座標）
let panStartOffset = null;            // パン開始時の viewOffset
let spacePressed = false;             // Space キーが押されているか


let penColor = '#000000';
let paths = [];
let undoStack = [];
let redoStack = [];
let currentPath = [];
let startTime = 0;
let selectedStrokes = new Set();
let altPressed = false;
let timelineLayout = [];
let timelineLassoStart = null;
let timelineLassoEnd = null;
let showInactive = false;

// オーバーレイ関連
let overlayStrokes = [];   // 一時表示用のストローク
let overlayActive = false; // オーバーレイ中かどうか
let overlayFilePaths = [];        // 読み込んだ JSON 内の paths 一式
let overlayFileSnapshots = [];    // 読み込んだ JSON 内の snapshots 一式
let overlaySelectedSnapshotIds = new Set();  // チェックされた snapshot.id

// スナップショット強調表示用メタ情報
let snapshotMeta = [];  // { id, activeIds, originalSnapshotId } の配列

// ストローク移動用（案2：スナップショットごとのレイアウト変形）
let currentTransforms = {};      // { [strokeId]: { dx, dy } }
let currentSnapshotId = null;    // 現在表示中のスナップショットID
let currentTool = 'pen';

let isMovingStrokes = false;     // ストローク移動中か
let moveStartMouse = null;       // ストローク移動開始時のマウス位置（画面座標）
let moveStartTransforms = null;  // 移動開始前の currentTransforms のコピー



// DOM要素
const penBtn = document.getElementById('pen');
const colorPicker = document.getElementById('colorPicker');
const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const clearBtn = document.getElementById('clear');
const saveBtn = document.getElementById('save');
const sizeSlider = document.getElementById('size');
const lassoBtn = document.getElementById('lasso');
const moveBtn = document.getElementById('move')
const toggleStrokeListBtn = document.getElementById('toggleStrokeListBtn');
const isolateSelectedBtn = document.getElementById('isolateSelectedBtn');
const strokeListEl = document.getElementById('strokeList');
const showInactiveBtn = document.getElementById('showInactiveBtn');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importInput = document.getElementById('importInput');
// オーバーレイ用ボタン／入力
const loadOverlayBtn = document.getElementById('loadOverlayBtn');
const applyOverlayBtn = document.getElementById('applyOverlayBtn');
const cancelOverlayBtn = document.getElementById('cancelOverlayBtn');
const overlayInput = document.getElementById('overlayInput');
const penConfigBtn = document.getElementById('penConfigBtn');
const penConfigPanel = document.getElementById('penConfigPanel');


// 定数
const INACTIVE_ALPHA_WHEN_ALT = 0.15;
const TIMELINE_LASSO_INCLUDES_INACTIVE = true;
const LASSO_MIN_PX = 6;
const DB_NAME = 'SketchAppDB';
const STORE_NAME = 'snapshots';
const PATHS_RECORD_ID = 'paths';
const DB_VERSION = 1;
let db;


// --- Pen 設定ポップアップの開閉 ---
if (penConfigBtn && penConfigPanel) {
  // トリガークリックで開閉
  penConfigBtn.addEventListener('click', (e) => {
    e.stopPropagation(); // 外側へのクリックイベント伝播を止める
    const isOpen = penConfigPanel.classList.toggle('is-open');
    penConfigBtn.setAttribute('aria-expanded', String(isOpen));
  });

  // パネル内クリックでは閉じないようにする
  penConfigPanel.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // 画面のどこかをクリックしたら閉じる
  document.addEventListener('click', () => {
    if (penConfigPanel.classList.contains('is-open')) {
      penConfigPanel.classList.remove('is-open');
      penConfigBtn.setAttribute('aria-expanded', 'false');
    }
  });
}



// 操作カウント（クリック回数と実行回数の両方）
function createEmptyOperationCounts() {
  return {
    // クリック履歴（タイムスタンプ付き配列）
    penClicks: [],
    lassoClicks: [],
    undoClicks: [],
    redoClicks: [],
    clearClicks: [],
    saveClicks: [],
    exportClicks: [],
    importClicks: [],
    toggleSelectedClicks: [],
    toggleStrokeListClicks: [],
    showInactiveClicks: [],
    
    // 実行履歴（タイムスタンプ付き配列）
    penExecuted: [],
    lassoExecuted: [],
    undoExecuted: [],
    redoExecuted: [],
    clearExecuted: [],
    saveExecuted: [],
    exportExecuted: [],
    importExecuted: [],
    toggleSelectedExecuted: [],
    toggleStrokeListExecuted: [],
    showInactiveExecuted: [],
    
    // その他
    snapshotSwitches: [],
    toggleActiveHistory: [],
    strokesDrawn: []
  };
}

let operationCounts = createEmptyOperationCounts();


// IndexedDB 初期化
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
    loadAllPathsFromDB();
    loadLatestSnapshot();
  };
  request.onerror = e => {
    console.error('IndexedDB open error:', e.target.errorCode);
  };
};

openDB();

// ユーティリティ関数
function generateStrokeId() {
  return 'stroke-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function isSmallRect(p1, p2) {
  return !p1 || !p2 || (Math.abs(p2.x - p1.x) < LASSO_MIN_PX && Math.abs(p2.y - p1.y) < LASSO_MIN_PX);
}

function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // 画面座標 + viewOffset = 世界座標
  return {
    x: screenX + viewOffset.x,
    y: screenY + viewOffset.y
  };
}



function getMousePosOnTimeline(e) {
  const rect = timelineCanvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top
  };
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

// IndexedDB 操作
function saveAllPathsToDB() {
  if (!db) return;
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    id: PATHS_RECORD_ID,
    paths: paths.map(p => ({ ...p }))
  });
  tx.oncomplete = () => {
    console.log('saveAllPathsToDB: paths saved');
  };
  tx.onerror = e => {
    console.error('saveAllPathsToDB error:', e.target.error);
  };
}

function loadAllPathsFromDB() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(PATHS_RECORD_ID);
  req.onsuccess = () => {
    if (req.result) {
      paths = req.result.paths.map(p => {
        if (Array.isArray(p.points) && p.points.length >= 2 && !p.points[0].tAbs) {
          const startAbs = performance.now();
          const dur = Math.max(1, p.duration || 1);
          p.points = p.points.map((pt, idx) => ({
            x: pt.x,
            y: pt.y,
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

async function exportAllData() {
  const now = Date.now();
  operationCounts.exportClicks.push(now);
  operationCounts.exportExecuted.push(now);
  console.log(
    'Export - Clicks:', operationCounts.exportClicks.length,
    'Executed:', operationCounts.exportExecuted.length
  );
  
  const tx1 = db.transaction([STORE_NAME], 'readonly');
  const store1 = tx1.objectStore(STORE_NAME);
  const pathsRec = await new Promise(resolve => {
    const req = store1.get(PATHS_RECORD_ID);
    req.onsuccess = () => resolve(req.result || { id: PATHS_RECORD_ID, paths: [] });
  });

  const tx2 = db.transaction([STORE_NAME], 'readonly');
  const store2 = tx2.objectStore(STORE_NAME);
  const allRecs = await new Promise(resolve => {
    const req = store2.getAll();
    req.onsuccess = () => resolve(req.result);
  });

  const snaps = allRecs.filter(r => r.id.startsWith('snapshot-'));

  const exportObj = {
    paths: pathsRec.paths,
    snapshots: snaps.map(r => ({
      id: r.id,
      timestamp: r.timestamp,
      activeIndexes: r.activeIds,
      preview: r.preview
    })),
    operationCounts: operationCounts
  };

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sketch-data-${new Date().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleImportFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;

  const now = Date.now();
  operationCounts.importClicks.push(now);
  operationCounts.importExecuted.push(now);
  console.log(
    'Import - Clicks:', operationCounts.importClicks.length,
    'Executed:', operationCounts.importExecuted.length
  );
  
  const reader = new FileReader();
reader.onload = async () => {
  try {
    const imported = JSON.parse(reader.result);
    const tx = db.transaction([STORE_NAME], 'readwrite');
    const store = tx.objectStore(STORE_NAME);

    // IndexedDB の中身を一旦全部クリア
    await new Promise(resolve => {
      const clearReq = store.clear();
      clearReq.onsuccess = () => resolve();
    });

    // paths を保存
    store.put({
      id: PATHS_RECORD_ID,
      paths: imported.paths || []
    });

    // snapshots を保存
    (imported.snapshots || []).forEach(snap => {
      const ids = Array.isArray(snap.activeIds)
        ? snap.activeIds
        : Array.isArray(snap.activeIndexes)
          ? snap.activeIndexes
          : [];
      store.put({
        id: snap.id,
        timestamp: snap.timestamp,
        activeIds: ids,
        preview: snap.preview
      });
    });

    await tx.complete;

    // ここでログをリセット：インポートしたら操作履歴はゼロから
    operationCounts = createEmptyOperationCounts();

    loadAllPathsFromDB();
    listSnapshots();
    loadLatestSnapshot();
    alert('インポート完了：全データをファイル内容で上書きしました（操作履歴はリセットされました）。');
  } catch (e) {
    console.error(e);
    alert('インポート中にエラーが発生しました');
  }
};

  reader.readAsText(file);
}

function handleOverlayFile(evt) {
  const file = evt.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);

      if (data.type === 'ChronoSnapshotV1' && Array.isArray(data.strokes)) {
        // シンプルな共有形式：1スナップショット扱いに変換
        overlayFilePaths = (data.strokes || []).map((st, idx) => ({
          id: `stroke-${idx}`,
          points: (st.points || []).map(pt => ({ x: pt.x, y: pt.y })),
          size: st.size ?? 2,
          color: st.color ?? '#000000',
          active: true
        }));
        overlayFileSnapshots = [{
          id: 'snapshot-1',
          timestamp: data.createdAt || null,
          activeIds: overlayFilePaths.map(p => p.id),
          preview: data.preview || null
        }];

      } else if (Array.isArray(data.paths) && Array.isArray(data.snapshots)) {
        // 通常の Export 形式
        overlayFilePaths = data.paths || [];
        overlayFileSnapshots = data.snapshots || [];

      } else {
        alert('対応しているスナップショット形式ではありません。');
        return;
      }

      // 最初は最新のスナップショットを選択状態にしておく
      overlaySelectedSnapshotIds.clear();
      if (overlayFileSnapshots.length > 0) {
        const latest = overlayFileSnapshots.reduce((a, b) => {
          const ta = new Date(a.timestamp || 0).getTime();
          const tb = new Date(b.timestamp || 0).getTime();
          return ta >= tb ? a : b;
        });
        overlaySelectedSnapshotIds.add(latest.id);
      }

      renderOverlaySnapshotList();
      updateOverlayFromSelection();
    } catch (e) {
      console.error(e);
      alert('オーバーレイの読み込み中にエラーが発生しました。');
    } finally {
      evt.target.value = '';
    }
  };
  reader.readAsText(file);
}


isolateSelectedBtn.addEventListener('click', () => {
  // 何も選択されていなかったら何もしない
  if (selectedStrokes.size === 0) {
    alert('Lsassoでストロークを選択してください。');
    return;
  }

  // 選択されている index の集合を作る
  const selectedIndexSet = new Set(selectedStrokes);

  // 選択されたものだけ active = true、それ以外は false
  paths.forEach((path, i) => {
    path.active = selectedIndexSet.has(i);
  });

  // UI 更新＋保存
  updateStrokeList();
  redraw();
  saveAllPathsToDB();
});


// 現在の「アクティブなストローク」だけを描いたプレビュー画像を返す
function generateSnapshotPreviewFromActiveStrokes() {
  // メインキャンバスと同じサイズのオフスクリーンキャンバスを作る
  const offCanvas = document.createElement('canvas');
  offCanvas.width = canvas.width;
  offCanvas.height = canvas.height;
  const offCtx = offCanvas.getContext('2d');

  // 背景を白で塗っておく（お好みで透明でもOK）
  offCtx.fillStyle = '#ffffff';
  offCtx.fillRect(0, 0, offCanvas.width, offCanvas.height);

  // active なストロークだけ描画
  paths.forEach(path => {
    if (!path.active) return;              // アクティブでないものはスキップ
    const pts = path.points;
    if (!pts || pts.length < 2) return;

    // このスナップショットでのレイアウト変形（Move モードの結果）
    const t = currentTransforms[path.id] || { dx: 0, dy: 0 };
    const dx = t.dx || 0;
    const dy = t.dy || 0;

    offCtx.save();
    offCtx.strokeStyle = path.color || '#000000';
    offCtx.lineWidth = path.size || 2;
    offCtx.lineCap = 'round';
    offCtx.lineJoin = 'round';

    // 「ユーザーが見ているカメラ(viewOffset)」に合わせる場合は
    // redraw() と同じく viewOffset を引く
    const x0 = pts[0].x + dx - viewOffset.x;
    const y0 = pts[0].y + dy - viewOffset.y;
    offCtx.beginPath();
    offCtx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) {
      const sx = pts[i].x + dx - viewOffset.x;
      const sy = pts[i].y + dy - viewOffset.y;
      offCtx.lineTo(sx, sy);
    }
    offCtx.stroke();
    offCtx.restore();
  });

  return offCanvas.toDataURL();
}



function saveSnapshot() {
  operationCounts.saveClicks.push(Date.now());
  operationCounts.saveExecuted.push(Date.now());
  console.log('Save - Clicks:', operationCounts.saveClicks.length, 'Executed:', operationCounts.saveExecuted.length);
  
  if (!db) return;
  const id = `snapshot-${Date.now()}`;

  // ★ ここを変更：アクティブストロークだけでプレビューを生成
  const preview = generateSnapshotPreviewFromActiveStrokes();

  const activeIds = paths.filter(p => p.active).map(p => p.id);

  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  store.put({
    id,
    timestamp: new Date().toISOString(),
    activeIds,
    preview,
    transforms: currentTransforms || {}   // このスナップショットでのレイアウト変形
  });

  tx.oncomplete = () => {
    currentSnapshotId = id;               // 今のスナップIDを覚えておく
    saveAllPathsToDB();
    listSnapshots();
    alert('スナップショットが保存されました！');
  };
  tx.onerror = e => {
    console.error('saveSnapshot transaction error:', e.target.error);
    alert('スナップショットの保存に失敗しました');
  };
}




function loadSnapshotById(snapshotId) {
  operationCounts.snapshotSwitches.push(Date.now());
  console.log('Snapshot Switch count:', operationCounts.snapshotSwitches.length);
  
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const req = store.get(snapshotId);

  req.onsuccess = () => {
    const snap = req.result;
    if (!snap || !Array.isArray(snap.activeIds)) return;

    currentSnapshotId = snap.id || null;

    // アクティブ状態を復元
    paths.forEach(p => p.active = false);
    snap.activeIds.forEach(id => {
      const p = paths.find(path => path.id === id);
      if (p) p.active = true;
    });

    // transforms を復元（なければ空オブジェクト）
    currentTransforms = snap.transforms || {};

    updateStrokeList();
    redraw();
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

    // DB から snapshot-* のレコードだけ抽出
    const snaps = request.result.filter(r => r.id.startsWith('snapshot-'));

    // ★ ハイライト判定用のメタ情報を作る
    snapshotMeta = snaps.map(s => {
      const ids =
        Array.isArray(s.activeIds) ? s.activeIds :
        Array.isArray(s.activeIndexes) ? s.activeIndexes :
        [];
      return {
        id: s.id,
        activeIds: ids,
        originalSnapshotId: s.originalSnapshotId || ''
      };
    });

    // ★ サムネ描画
    snaps.forEach(snapshot => {
      const div = document.createElement('div');
      div.style.marginBottom = '10px';
      div.dataset.snapshotId = snapshot.id;
      div.classList.add('snapshot-item');

      const img = document.createElement('img');
      img.src = snapshot.preview;
      img.width = 130;
      img.height = 80;
      img.style.border = '1px solid #ccc';
      const ts = new Date(snapshot.timestamp).toLocaleString();
      img.title = ts;
      img.addEventListener('click', () => loadSnapshotById(snapshot.id));
      div.appendChild(img);

      // ★ オーバーレイインポートしたスナップショットなら見た目を変える
      if (snapshot.originalSnapshotId) {
        div.classList.add('snapshot-imported');

        const badge = document.createElement('div');
        badge.className = 'snapshot-badge';
        badge.textContent = 'Imported';
        div.appendChild(badge);
      }

      list.appendChild(div);
    });

    // ★ 選択ストロークに応じたハイライトを反映
    highlightSnapshotsForSelection();
  };
}



function renderOverlaySnapshotList() {
  const list = document.getElementById('overlaySnapshotList');
  list.innerHTML = '';

  if (!overlayFileSnapshots || overlayFileSnapshots.length === 0) {
    list.textContent = '（オーバーレイ用スナップショットなし）';
    return;
  }

  const block = document.createElement('div');
  block.className = 'overlay-snapshot-block';

  const title = document.createElement('div');
  title.className = 'overlay-snapshot-title';
  title.textContent = 'Overlay Snapshots (from file)';
  block.appendChild(title);

  // timestamp順に並べ替え（古い→新しい）
  const snapsSorted = overlayFileSnapshots
    .slice()
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  snapsSorted.forEach(snap => {
    const item = document.createElement('div');
    item.className = 'overlay-snapshot-item';

    // サムネイル
    if (snap.preview) {
      const img = document.createElement('img');
      img.src = snap.preview;
      img.width = 130;
      img.height = 80;
      img.title = snap.id;
      item.appendChild(img);
    }

    // チェックボックス + ラベル
    const line = document.createElement('div');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = snap.id;
    checkbox.checked = overlaySelectedSnapshotIds.has(snap.id);

    const label = document.createElement('label');
    const ts = snap.timestamp ? new Date(snap.timestamp).toLocaleString() : '(no time)';
    label.textContent = `${snap.id} / ${ts}`;
    label.style.marginLeft = '4px';

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        overlaySelectedSnapshotIds.add(snap.id);
      } else {
        overlaySelectedSnapshotIds.delete(snap.id);
      }
      updateOverlayFromSelection();
    });

    line.appendChild(checkbox);
    line.appendChild(label);
    item.appendChild(line);

    block.appendChild(item);
  });

  list.appendChild(block);
}


function updateOverlayFromSelection() {
  overlayStrokes = [];

  if (!overlayFilePaths || overlayFilePaths.length === 0) {
    overlayActive = false;
    applyOverlayBtn.disabled = true;
    cancelOverlayBtn.disabled = true;
    redraw();
    return;
  }

  if (overlaySelectedSnapshotIds.size === 0) {
    // 何も選ばれていない → オーバーレイ解除
    overlayActive = false;
    applyOverlayBtn.disabled = true;
    cancelOverlayBtn.disabled = true;
    redraw();
    return;
  }

  // 選択されたスナップショットに含まれる activeIds を全部集める
  const idSet = new Set();
  overlayFileSnapshots.forEach(snap => {
    if (!overlaySelectedSnapshotIds.has(snap.id)) return;

    const ids =
      Array.isArray(snap.activeIds) ? snap.activeIds :
      Array.isArray(snap.activeIndexes) ? snap.activeIndexes :
      [];

    if (ids.length > 0) {
      ids.forEach(id => idSet.add(id));
    } else {
      // activeIds が無い場合は active !== false な paths 全部を使う
      overlayFilePaths
        .filter(p => p.active !== false)
        .forEach(p => idSet.add(p.id));
    }
  });

  const strokes = overlayFilePaths.filter(p => idSet.has(p.id));

  if (strokes.length === 0) {
    overlayActive = false;
    applyOverlayBtn.disabled = true;
    cancelOverlayBtn.disabled = false;
    redraw();
    return;
  }

  overlayStrokes = strokes.map(st => ({
    originalId: st.id,
    points: (st.points || []).map(pt => ({ x: pt.x, y: pt.y })),
    size: st.size ?? 2,
    color: st.color ?? '#000000'
  }));

  overlayActive = true;
  applyOverlayBtn.disabled = false;
  cancelOverlayBtn.disabled = false;

  redraw();
}



function loadLatestSnapshot() {
  const tx = db.transaction([STORE_NAME], 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const getAllReq = store.getAll();
  getAllReq.onsuccess = () => {
    const snaps = getAllReq.result.filter(s => s.id.startsWith('snapshot-'));
    if (snaps.length === 0) return;
    const latest = snaps.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];
    loadSnapshotById(latest.id);
  };
}

// モード切り替え
function updateModeUI() {
  const penActive   = (currentTool === 'pen');
  const lassoActive = (currentTool === 'lasso');
  const moveActive  = (currentTool === 'move');

  penBtn.classList.toggle('is-active', penActive);
  lassoBtn.classList.toggle('is-active', lassoActive);
  if (moveBtn) {
    moveBtn.classList.toggle('is-active', moveActive);
  }

  penBtn.setAttribute('aria-pressed', String(penActive));
  lassoBtn.setAttribute('aria-pressed', String(lassoActive));
  if (moveBtn) {
    moveBtn.setAttribute('aria-pressed', String(moveActive));
  }
}

function setMode(mode) {
  // mode: 'pen' | 'lasso' | 'move'
  currentTool = mode;

  // 既存コードが lassoMode を参照しているので、ここだけ同期しておく
  lassoMode = (mode === 'lasso');

  // モード切り替え時に状態をリセット
  isMovingStrokes = false;
  drawing = false;
  lassoStart = null;
  lassoEnd = null;
  timelineLassoStart = null;
  timelineLassoEnd = null;

  // 選択状態は維持したほうが便利なのでそのまま残す
  // （もしモード切り替えで選択も消したいなら下行を有効化）
  // selectedStrokes.clear();

  updateModeUI();
  redraw();
  updateStrokeList();
}

// 描画関数

function drawTimeline() {
  if (!timelineCanvas || !tl) return;
  const dpr = window.devicePixelRatio || 1;
  let cssW = timelineCanvas.clientWidth;
  const cssH = timelineCanvas.clientHeight;
  cssW = Math.min(cssW, 200);
  
  if (timelineCanvas.width !== Math.floor(cssW * dpr) || timelineCanvas.height !== Math.floor(cssH * dpr)) {
    timelineCanvas.width = Math.floor(cssW * dpr);
    timelineCanvas.height = Math.floor(cssH * dpr);
    tl.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  tl.clearRect(0, 0, cssW, cssH);

  const visible = paths.filter(s => s.points && s.points.length >= 2);
  if (visible.length === 0 || !paths.length) return;

  // 描画順の基準（元コードそのまま）
  const basis = [...paths].sort((a, b) => {
    const aStart = (a.startTime ?? a.startTimeAbs ?? a.points?.[0]?.tAbs ?? 0);
    const bStart = (b.startTime ?? b.startTimeAbs ?? b.points?.[0]?.tAbs ?? 0);
    return aStart - bStart;
  });

  const offsets = new Map();
  let cum = 0;
  for (const s of basis) {
    const s0 = s.startTimeAbs ?? s.points?.[0]?.tAbs ?? s.startTime ?? 0;
    const sN = s.endTimeAbs ?? s.points?.[s.points.length - 1]?.tAbs ?? s.endTime ?? s0;
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

  // 背景グリッド
  tl.save();
  tl.strokeStyle = '#cfcfcf';
  tl.lineWidth = 1;
  for (let k = 0; k <= 5; k++) {
    const y = (k / 5) * cssH;
    tl.beginPath();
    tl.moveTo(0, y);
    tl.lineTo(cssW, y);
    tl.stroke();
  }
  tl.restore();

  // タイムライン用レイアウト情報を構築
  timelineLayout = [];
  for (const s of visible) {
    const pts = s.points;
    if (!pts || pts.length < 2) continue;
    const mapped = pts.map(p => ({ x: xOf(p.x), y: yOfPoint(s, p.tAbs) }));
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

  // ID → タイムラインアイテムのマップ（親子線を引くため）
  const idToTimelineItem = new Map();
  timelineLayout.forEach(item => {
    idToTimelineItem.set(item.id, item);
  });

  // 各ストロークのタイムライン本体を描画
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
    if (isSelected) {
      tl.setLineDash([6, 4]);
    } else {
      tl.setLineDash([]);
    }
    tl.beginPath();
    tl.moveTo(xOf(pts[0].x), yOfPoint(s, pts[0].tAbs));
    for (let j = 1; j < pts.length; j++) {
      tl.lineTo(xOf(pts[j].x), yOfPoint(s, pts[j].tAbs));
    }
    tl.stroke();
    tl.restore();
  }

  // 親子ストロークをタイムライン上で点線で結ぶ
  // ⚠ 親 or 子のどちらかが選択されている場合だけ描画
  for (const item of timelineLayout) {
    const childIdx = item.index;
    const stroke = paths[childIdx];
    if (!stroke || !stroke.parentId) continue;

    // 子が選択されているか？
    const childSelected = selectedStrokes.has(childIdx);

    // 親ストロークの index を探す
    const parentIdx = paths.findIndex(p => p && p.id === stroke.parentId);
    if (parentIdx === -1) continue;

    // 親が選択されているか？
    const parentSelected = selectedStrokes.has(parentIdx);

    // 親子どちらも選択されていないなら線は描かない
    if (!childSelected && !parentSelected) continue;

    const parentItem = idToTimelineItem.get(stroke.parentId);
    if (!parentItem) continue;

    const childPts  = item.points;
    const parentPts = parentItem.points;
    if (!childPts.length || !parentPts.length) continue;

    const childMid  = childPts[Math.floor(childPts.length  / 2)];
    const parentMid = parentPts[Math.floor(parentPts.length / 2)];

    tl.save();
    // 選択された系統なので、さっきより少しだけはっきり目でもOK
    tl.strokeStyle = 'rgba(80, 80, 80, 0.7)';
    tl.lineWidth = 1;
    tl.setLineDash([3, 3]);
    tl.beginPath();
    tl.moveTo(parentMid.x, parentMid.y);
    tl.lineTo(childMid.x,  childMid.y);
    tl.stroke();
    tl.restore();
  }

  // ラッソ矩形
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

  // メインキャンバス上のストローク描画
  paths.forEach((path, i) => {
    const isSelected = selectedStrokes.has(i);
    const isInactive = !path.active;
    const revealInactive = altPressed || showInactive;
    if (isInactive && !revealInactive && !isSelected) return;

    ctx.save();
    ctx.setLineDash(isSelected ? [6, 4] : []);
    if (isInactive) {
      ctx.globalAlpha = isSelected ? 0.15 : 0.15;
    } else {
      ctx.globalAlpha = 1.0;
    }
    ctx.strokeStyle = path.color;
    ctx.lineWidth = path.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pts = path.points;
    if (pts && pts.length >= 2) {
      // このスナップショットにおけるレイアウト変形（currentTransforms）を適用
      const t = currentTransforms[path.id] || { dx: 0, dy: 0 };
      const dx = t.dx || 0;
      const dy = t.dy || 0;

      ctx.beginPath();
      // 世界座標 → 画面座標：（基準 + transform）- viewOffset
      const x0 = pts[0].x + dx - viewOffset.x;
      const y0 = pts[0].y + dy - viewOffset.y;
      ctx.moveTo(x0, y0);
      for (let j = 1; j < pts.length; j++) {
        const sx = pts[j].x + dx - viewOffset.x;
        const sy = pts[j].y + dy - viewOffset.y;
        ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }
    ctx.restore();
  });

  // ラッソ矩形
  if (lassoMode && lassoStart && lassoEnd) {
    ctx.save();
    ctx.globalAlpha = 1.0;
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = 'rgba(0,0,255,0.5)';
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.min(lassoStart.x, lassoEnd.x) - viewOffset.x,
      Math.min(lassoStart.y, lassoEnd.y) - viewOffset.y,
      Math.abs(lassoEnd.x - lassoStart.x),
      Math.abs(lassoEnd.y - lassoStart.y)
    );
    ctx.restore();
  }

  // オーバーレイ描画
  if (overlayActive && overlayStrokes.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.4;        // 半透明
    ctx.setLineDash([]);          // 実線
    overlayStrokes.forEach(st => {
      const pts = st.points;
      if (!pts || pts.length < 2) return;
      ctx.strokeStyle = st.color || '#666666';
      ctx.lineWidth = st.size || 2;
      ctx.beginPath();
      ctx.moveTo(pts[0].x - viewOffset.x, pts[0].y - viewOffset.y);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x - viewOffset.x, pts[i].y - viewOffset.y);
      }
      ctx.stroke();
    });
    ctx.restore();
  }

  drawTimeline();
}



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

function updateStrokeList() {
  const list = document.getElementById('strokeList');
  list.innerHTML = '';
  paths.forEach((path, i) => {
    const div = document.createElement('div');
    div.className = 'stroke-entry';
    if (selectedStrokes.has(i)) {
      div.style.backgroundColor = '#ffffcc';
    }
    const ts = new Date(path.startTime).toLocaleString();
    const info = document.createElement('div');
    info.innerHTML = `${ts} — ${path.duration}ms, ${path.length.toFixed(1)}px, ${path.speed.toFixed(2)}px/ms<br>
    <label>
      <input type="checkbox" ${path.active ? 'checked' : ''} onchange="toggleActive(${i})">
      Active
    </label>`;
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
  highlightSnapshotsForSelection();
}

function highlightSnapshotsForSelection() {
  const list = document.getElementById('snapshotList');
  if (!list) return;

  // 1. 選択されているストロークの id 集合
  const selectedStrokeIds = new Set();
  selectedStrokes.forEach(idx => {
    const p = paths[idx];
    if (p && typeof p.id === 'string') {
      selectedStrokeIds.add(p.id);
    }
  });

  // 2. 各スナップショットが選択ストロークを含むかどうか判定
  const snapshotHasSelection = new Map();
  snapshotMeta.forEach(snap => {
    const ids = snap.activeIds || [];
    const has = ids.some(id => selectedStrokeIds.has(id));
    snapshotHasSelection.set(snap.id, has);
  });

  // 3. DOM に小さなバッジを付け外し
  Array.from(list.children).forEach(child => {
    const sid = child.dataset.snapshotId;
    if (!sid) return;

    const hasSelection = !!snapshotHasSelection.get(sid);

    // 既存のバッジ（あれば）を取得
    let badge = child.querySelector('.snapshot-selected-badge');

    if (hasSelection) {
      // なければ作る
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'snapshot-selected-badge';
        badge.textContent = 'Sel'; // 好きに変えてOK（●とか★とか）
        child.appendChild(badge);
      }
    } else {
      // 対応するストロークを含まない → バッジは外す
      if (badge) {
        badge.remove();
      }
    }
  });
}





function toggleActive(index) {
  operationCounts.toggleActiveHistory.push(Date.now());
  console.log('Toggle Active count:', operationCounts.toggleActiveHistory.length);
  
  paths[index].active = !paths[index].active;
  updateStrokeList();
  redraw();
  saveAllPathsToDB();
}

function selectStrokesInLasso(p1, p2) {
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  selectedStrokes.clear();
  const revealInactive = altPressed || showInactive;
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

function selectStrokesInTimelineLasso(p1, p2) {
  if (!timelineLayout || timelineLayout.length === 0) return;
  const minX = Math.min(p1.x, p2.x);
  const minY = Math.min(p1.y, p2.y);
  const maxX = Math.max(p1.x, p2.x);
  const maxY = Math.max(p1.y, p2.y);
  const inRect = (pt) => (pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY);
  selectedStrokes.clear();
  for (const item of timelineLayout) {
    if (!item.active && !TIMELINE_LASSO_INCLUDES_INACTIVE && !altPressed) continue;
    const b = item.bbox;
    const bboxOverlap = !(b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY);
    if (!bboxOverlap) continue;
    let hit = false;
    for (const pt of item.points) {
      if (inRect(pt)) {
        hit = true;
        break;
      }
    }
    if (hit) selectedStrokes.add(item.index);
  }
}

// イベントリスナー
sizeSlider.addEventListener('input', (e) => {
  penSize = parseInt(e.target.value);
});

colorPicker.addEventListener('input', (e) => {
  penColor = e.target.value;
});

penBtn.addEventListener('click', () => {
  operationCounts.penClicks.push(Date.now());
  if (currentTool !== 'pen') {
    operationCounts.penExecuted.push(Date.now());
  }
  console.log('Pen - Clicks:', operationCounts.penClicks.length, 'Executed:', operationCounts.penExecuted.length);
  setMode('pen');
});

lassoBtn.addEventListener('click', () => {
  operationCounts.lassoClicks.push(Date.now());
  if (currentTool !== 'lasso') {
    operationCounts.lassoExecuted.push(Date.now());
  }
  console.log('Lasso - Clicks:', operationCounts.lassoClicks.length, 'Executed:', operationCounts.lassoExecuted.length);
  setMode('lasso');
});


if (moveBtn) {
  moveBtn.addEventListener('click', () => {
    setMode('move');
  });
}

undoBtn.addEventListener('click', () => {
  operationCounts.undoClicks.push(Date.now());
  if (paths.length > 0) {
    operationCounts.undoExecuted.push(Date.now());
    redoStack.push(paths.pop());
    updateStrokeList();
  }
  console.log('Undo - Clicks:', operationCounts.undoClicks.length, 'Executed:', operationCounts.undoExecuted.length);
});

redoBtn.addEventListener('click', () => {
  operationCounts.redoClicks.push(Date.now());
  if (redoStack.length > 0) {
    operationCounts.redoExecuted.push(Date.now());
    paths.push(redoStack.pop());
    updateStrokeList();
  }
  console.log('Redo - Clicks:', operationCounts.redoClicks.length, 'Executed:', operationCounts.redoExecuted.length);
});

clearBtn.addEventListener('click', () => {
  operationCounts.clearClicks.push(Date.now());
  operationCounts.clearExecuted.push(Date.now());
  console.log('Clear - Clicks:', operationCounts.clearClicks.length, 'Executed:', operationCounts.clearExecuted.length);
  saveSnapshot();
  paths.forEach(path => path.active = false);
  redoStack = [];
  updateStrokeList();
  redraw();
});

saveBtn.addEventListener('click', () => {
  saveSnapshot();
});

showInactiveBtn.addEventListener('click', () => {
  operationCounts.showInactiveClicks.push(Date.now());
  operationCounts.showInactiveExecuted.push(Date.now());
  console.log('Show Inactive - Clicks:', operationCounts.showInactiveClicks.length, 'Executed:', operationCounts.showInactiveExecuted.length);
  showInactive = !showInactive;
  showInactiveBtn.classList.toggle('active', showInactive);
  showInactiveBtn.setAttribute('aria-pressed', String(showInactive));
  redraw();
  updateStrokeList();
});

toggleStrokeListBtn.addEventListener('click', () => {
  operationCounts.toggleStrokeListClicks.push(Date.now());
  operationCounts.toggleStrokeListExecuted.push(Date.now());
  console.log('Toggle Stroke List - Clicks:', operationCounts.toggleStrokeListClicks.length, 'Executed:', operationCounts.toggleStrokeListExecuted.length);
  if (strokeListEl.style.display === 'none' || strokeListEl.style.display === '') {
    strokeListEl.style.display = 'block';
  } else {
    strokeListEl.style.display = 'none';
  }
});

document.getElementById('toggleSelectedBtn').addEventListener('click', () => {
  operationCounts.toggleSelectedClicks.push(Date.now());
  if (selectedStrokes.size > 0) {
    operationCounts.toggleSelectedExecuted.push(Date.now());
    selectedStrokes.forEach(index => {
      paths[index].active = !paths[index].active;
    });
    updateStrokeList();
  }
  console.log('Toggle Selected - Clicks:', operationCounts.toggleSelectedClicks.length, 'Executed:', operationCounts.toggleSelectedExecuted.length);
});

exportBtn.addEventListener('click', exportAllData);
importBtn.addEventListener('click', () => importInput.click());
importInput.addEventListener('change', handleImportFile);

window.addEventListener('keydown', (e) => {
  // Alt 押下
  if (e.key === 'Alt') {
    altPressed = true;
    redraw();
    updateStrokeList();
  }

  // Space 押下（ブラウザごとの差を吸収）
  if (e.code === 'Space' || e.key === ' ') {
    spacePressed = true;
    // ページスクロールを防ぐ
    e.preventDefault();
  }

  // フォームにフォーカスがあるときはショートカット無効
  if (e.target && /input|textarea|select/i.test(e.target.tagName)) {
    return;
  }

  // ペンモード切り替え（V）
  if (e.key === 'v' || e.key === 'V') {
    operationCounts.penClicks.push(Date.now());
    if (lassoMode) {
      operationCounts.penExecuted.push(Date.now());
    }
    setMode('pen');
  }

  // ラッソモード切り替え（L）
  if (e.key === 'l' || e.key === 'L') {
    operationCounts.lassoClicks.push(Date.now());
    if (!lassoMode) {
      operationCounts.lassoExecuted.push(Date.now());
    }
    setMode('lasso');
  }
});

window.addEventListener('keyup', (e) => {
  // Alt 離した
  if (e.key === 'Alt') {
    altPressed = false;
    redraw();
    updateStrokeList();
  }

  // Space 離した → パン終了
  if (e.code === 'Space' || e.key === ' ') {
    spacePressed = false;
    isPanning = false;
  }
});

// --- オーバーレイ関連イベント ---

// ファイル選択を開く
loadOverlayBtn.addEventListener('click', () => {
  overlayInput.click();
});

// ファイル選択後の処理
overlayInput.addEventListener('change', handleOverlayFile);


applyOverlayBtn.addEventListener('click', () => {
  if (!overlayActive || overlayStrokes.length === 0) return;
  if (!db) {
    alert('データベースが初期化されていません。ページを再読み込みしてみてください。');
    return;
  }

  if (overlaySelectedSnapshotIds.size === 0) {
    alert('取り込むスナップショットが選択されていません。');
    return;
  }

  // 1. 選択されたスナップショットだけ抽出
  const selectedSnaps = overlayFileSnapshots.filter(snap =>
    overlaySelectedSnapshotIds.has(snap.id)
  );

  if (selectedSnaps.length === 0) {
    alert('選択されたスナップショットが見つかりませんでした。');
    return;
  }

  // 2. そのスナップショットで使われている stroke id の集合を作る
  const idSet = new Set();
  selectedSnaps.forEach(snap => {
    const ids =
      Array.isArray(snap.activeIds) ? snap.activeIds :
      Array.isArray(snap.activeIndexes) ? snap.activeIndexes :
      [];

    if (ids.length > 0) {
      ids.forEach(id => idSet.add(id));
    } else {
      // activeIds が無い場合は active !== false な paths を全部
      overlayFilePaths
        .filter(p => p.active !== false)
        .forEach(p => idSet.add(p.id));
    }
  });

  // 3. 実際に取り込むストローク配列
  const strokesToImport = overlayFilePaths.filter(p => idSet.has(p.id));

  if (strokesToImport.length === 0) {
    alert('取り込むストロークが見つかりませんでした。');
    return;
  }

  // 4. 旧ID → 新ID の対応マップを作りながら paths に追加
  const idMap = new Map(); // oldId -> newId

  strokesToImport.forEach(src => {
    if (!src.points || src.points.length < 2) return;

    const now = Date.now();
    const absBase = performance.now();  // このストロークの基準時間

    // ★ 位置はそのまま、tAbs だけ「ポイントごとに +1ms」ずらして縦の長さを作る
    const points = src.points.map((pt, idx) => ({
      x: pt.x,
      y: pt.y,
      tAbs: absBase + idx   // ← idx を足すことで start と end に差ができる
    }));

    // タイムライン用の絶対時間（見た目用）
    const startTimeAbs = points[0].tAbs;
    const endTimeAbs   = points[points.length - 1].tAbs;

    // メトリクスとしては「描画時間 0ms」に固定
    const startTime = now;
    const endTime   = now;
    const duration  = 0;

    const length = calcLength(points);
    const speed  = 0;     // duration 0 として扱うので 0 に固定

    const newId = generateStrokeId();

    // ★ ここ重要：旧ID → 新ID を記録して、あとで snapshot の activeIds に変換する
    idMap.set(src.id, newId);

    const newStroke = {
      id: newId,
      points,
      size: src.size ?? 2,
      color: src.color ?? '#000000',
      startTime,
      endTime,
      duration,       // 0ms
      length,
      speed,          // 0
      active: true,
      startTimeAbs,   // タイムライン用には「差のある値」
      endTimeAbs
    };

    paths.push(newStroke);
  });

  // 5. 新しいスナップショットレコードを作成して IndexedDB に保存
  const tx = db.transaction([STORE_NAME], 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  let counter = 0;
  selectedSnaps.forEach(srcSnap => {
    const srcIds =
      Array.isArray(srcSnap.activeIds) ? srcSnap.activeIds :
      Array.isArray(srcSnap.activeIndexes) ? srcSnap.activeIndexes :
      [];

    // オーバーレイ側の stroke id を新しい id に変換
    const mappedActiveIds = srcIds
      .map(oldId => idMap.get(oldId))
      .filter(id => typeof id === 'string' && id.length > 0);

    if (mappedActiveIds.length === 0) {
      console.warn('No mappable strokes for snapshot', srcSnap.id, srcIds);
      return;
    }

    const newSnapId = `snapshot-import-${Date.now()}-${counter++}`;

    const newSnap = {
      id: newSnapId,
      timestamp: srcSnap.timestamp || new Date().toISOString(),
      activeIds: mappedActiveIds,          // ★ ここがハイライト等にも使われる
      preview: srcSnap.preview || null,
      originalSnapshotId: srcSnap.id || ''
    };

    store.put(newSnap);
  });

  tx.oncomplete = () => {
    // paths も保存・UI 更新
    redoStack = [];
    saveAllPathsToDB();
    listSnapshots();
    updateStrokeList();
    redraw();

    // オーバーレイ状態のリセット
    overlayStrokes = [];
    overlayActive = false;
    overlaySelectedSnapshotIds.clear();
    applyOverlayBtn.disabled = true;
    cancelOverlayBtn.disabled = true;

    alert('選択したスナップショットのストロークとスナップショットを取り込みました。');
  };

  tx.onerror = e => {
    console.error('Import snapshots error:', e.target.error);
    alert('スナップショットの取り込み中にエラーが発生しました。');
  };
});




// オーバーレイをキャンセル（破棄）
cancelOverlayBtn.addEventListener('click', () => {
  overlayStrokes = [];
  overlayActive = false;
  applyOverlayBtn.disabled = true;
  cancelOverlayBtn.disabled = true;
  redraw();
});


window.addEventListener('keyup', e => {
  if (e.key === 'Alt') {
    altPressed = false;
    redraw();
    updateStrokeList();
  }
});

// キャンバスイベント
canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // === Move モード：選択中ストロークの移動開始 ===
  if (currentTool === 'move' && selectedStrokes.size > 0) {
    isMovingStrokes = true;
    moveStartMouse = { x: screenX, y: screenY };
    // 現在の transforms をコピーして保持
    moveStartTransforms = JSON.parse(JSON.stringify(currentTransforms || {}));
    return;
  }

  // === Lasso モード：範囲選択開始 ===
  if (currentTool === 'lasso') {
    lassoStart = getMousePos(e);  // 世界座標（viewOffset を含む）
    lassoEnd = null;
    return;
  }

  // === Pen モード：描画開始 ===
  if (currentTool === 'pen') {
    drawing = true;
    startTime = Date.now();
    const pos = getMousePos(e);   // 世界座標
    currentPath = [{ x: pos.x, y: pos.y, tAbs: performance.now() }];
    return;
  }
});

canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const screenX = e.clientX - rect.left;
  const screenY = e.clientY - rect.top;

  // === Move モード：ドラッグ中は選択ストロークを動かす ===
  if (isMovingStrokes && currentTool === 'move') {
    const dx = screenX - moveStartMouse.x;
    const dy = screenY - moveStartMouse.y;

    const base = moveStartTransforms || {};
    const newTransforms = { ...base };

    selectedStrokes.forEach(idx => {
      const stroke = paths[idx];
      if (!stroke) return;
      const id = stroke.id;
      const prev = base[id] || { dx: 0, dy: 0 };
      newTransforms[id] = {
        dx: prev.dx + dx,
        dy: prev.dy + dy
      };
    });

    currentTransforms = newTransforms;
    redraw();
    return;
  }

  // === Lasso モード中：ラッソ矩形を更新 ===
  if (currentTool === 'lasso' && lassoStart) {
    lassoEnd = getMousePos(e);
    redraw();
    return;
  }

  // === Pen モード中：線を伸ばす ===
  if (currentTool === 'pen' && drawing) {
    const pos = getMousePos(e);
    currentPath.push({ x: pos.x, y: pos.y, tAbs: performance.now() });

    // 描きながら即時表示（viewOffset を引いて画面座標に）
    ctx.lineWidth = penSize;
    ctx.lineCap = 'round';
    ctx.strokeStyle = penColor;
    const len = currentPath.length;
    if (len >= 2) {
      const p1 = currentPath[len - 2];
      const p2 = currentPath[len - 1];
      ctx.beginPath();
      ctx.moveTo(p1.x - viewOffset.x, p1.y - viewOffset.y);
      ctx.lineTo(p2.x - viewOffset.x, p2.y - viewOffset.y);
      ctx.stroke();
    }
  }
});


canvas.addEventListener('mouseup', (e) => {
  // === Move モード：移動確定 → 新ストローク追加＆元を inactive にする ===
  if (isMovingStrokes && currentTool === 'move') {
    isMovingStrokes = false;

    if (selectedStrokes.size > 0) {
      const now = Date.now();
      const abs = performance.now();
      const newSelectedIndexes = [];

      selectedStrokes.forEach(idx => {
        const original = paths[idx];
        if (!original || !original.points || original.points.length < 2) return;

        // このストロークに対して適用された最終的な移動量
        const t = (currentTransforms && currentTransforms[original.id]) || { dx: 0, dy: 0 };
        const dx = t.dx || 0;
        const dy = t.dy || 0;

        // 移動後の座標を「新しいストローク」として確定（viewOffset は含めない）
        const newPoints = original.points.map(pt => ({
          x: pt.x + dx,
          y: pt.y + dy,
          tAbs: abs          // ★ 全点同じ → 描画時間 0ms 扱い
        }));

        if (newPoints.length < 2) return;

        const length = calcLength(newPoints);

        const newStroke = {
          id: generateStrokeId(),
          points: newPoints,
          size: original.size,
          color: original.color,
          startTime: now,
          endTime: now,
          duration: 0,        // ★ 0ms
          length,
          speed: 0,           // 好きなら length/1 でもOK
          active: true,
          startTimeAbs: abs,
          endTimeAbs: abs,

          // ★ ここが大事：どのストロークから移動してきたか
          parentId: original.id
        };

        paths.push(newStroke);
        const newIndex = paths.length - 1;
        newSelectedIndexes.push(newIndex);

        // 元のストロークは inactive に
        original.active = false;

        // 元ストローク用の transform はもう不要なので削除
        if (currentTransforms && currentTransforms[original.id]) {
          delete currentTransforms[original.id];
        }
      });

      // 選択状態を新しいストローク側に移す（好みで）
      selectedStrokes.clear();
      newSelectedIndexes.forEach(i => selectedStrokes.add(i));

      redoStack = [];
      updateStrokeList();
      saveAllPathsToDB();
      redraw();
    }

    moveStartMouse = null;
    moveStartTransforms = null;
    return;
  }

  // === Lasso モード：選択確定 ===
  if (currentTool === 'lasso') {
    if (lassoStart && lassoEnd && !isSmallRect(lassoStart, lassoEnd)) {
      selectStrokesInLasso(lassoStart, lassoEnd);
    }
    lassoStart = null;
    lassoEnd = null;
    drawing = false;
    currentPath = [];
    updateStrokeList();
    redraw();
    return;
  }

  // === Pen モード：描画終了 → ストローク確定 ===
  if (currentTool === 'pen') {
    const endTime = Date.now();
    const duration = endTime - startTime;

    if (drawing && currentPath.length > 1) {
      operationCounts.strokesDrawn.push(Date.now());
      console.log('Stroke Drawn count:', operationCounts.strokesDrawn.length);

      const startAbs = currentPath[0].tAbs ?? performance.now();
      const endAbs = currentPath.at(-1).tAbs ?? (startAbs + duration);
      const length = calcLength(currentPath);
      const speed = length / Math.max(1, duration);

      const stroke = {
        id: generateStrokeId(),
        points: currentPath,
        size: penSize,
        color: penColor,
        startTime,
        endTime,
        duration,
        length,
        speed,
        active: true,
        startTimeAbs: startAbs,
        endTimeAbs: endAbs
      };
      paths.push(stroke);
      redoStack = [];
      updateStrokeList();
      saveAllPathsToDB();
    }
    drawing = false;
  }
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

// タイムラインイベント
timelineCanvas.addEventListener('mousedown', (e) => {
  if (!lassoMode) return;
  timelineLassoStart = getMousePosOnTimeline(e);
  timelineLassoEnd = null;
  drawTimeline();
});

timelineCanvas.addEventListener('mousemove', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);
  drawTimeline();
});

timelineCanvas.addEventListener('mouseup', (e) => {
  if (!lassoMode || !timelineLassoStart) return;
  timelineLassoEnd = getMousePosOnTimeline(e);
  if (isSmallRect(timelineLassoStart, timelineLassoEnd)) {
    timelineLassoStart = null;
    timelineLassoEnd = null;
    drawTimeline();
    return;
  }
  selectStrokesInTimelineLasso(timelineLassoStart, timelineLassoEnd);
  timelineLassoStart = null;
  timelineLassoEnd = null;
  updateStrokeList();
  redraw();
});


async function exportOperationCountsAsCSV() {
  let csv = 'Operation,Type,Date,Time\n';

  // 日時フォーマット関数（日本時間で出力）
  const formatDateTime = (ts) => {
    const d = new Date(ts);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return {
      date: `${yyyy}/${mm}/${dd}`,
      time: `${hh}:${min}:${ss}`,
    };
  };

  // クリック＋実行を持つ操作の出力
  const addTwoTypeSection = (name, clicks, executed) => {
    const rows = [];
    (clicks || []).forEach(ts => typeof ts === 'number' && rows.push({ op: name, type: 'Click', ts }));
    (executed || []).forEach(ts => typeof ts === 'number' && rows.push({ op: name, type: 'Executed', ts }));
    if (rows.length === 0) return;
    rows.sort((a, b) => a.ts - b.ts);
    rows.forEach(r => {
      const t = formatDateTime(r.ts);
      csv += `${r.op},${r.type},${t.date},${t.time}\n`;
    });
    csv += '\n';
  };

  // 実行のみを持つ操作の出力
  const addSingleTypeSection = (name, executed) => {
    const rows = [];
    (executed || []).forEach(ts => typeof ts === 'number' && rows.push({ op: name, type: 'Executed', ts }));
    if (rows.length === 0) return;
    rows.sort((a, b) => a.ts - b.ts);
    rows.forEach(r => {
      const t = formatDateTime(r.ts);
      csv += `${r.op},${r.type},${t.date},${t.time}\n`;
    });
    csv += '\n';
  };

  // ==== 出力ブロック ====
  addTwoTypeSection('Pen', operationCounts.penClicks, operationCounts.penExecuted);
  addTwoTypeSection('Lasso', operationCounts.lassoClicks, operationCounts.lassoExecuted);
  addTwoTypeSection('Undo', operationCounts.undoClicks, operationCounts.undoExecuted);
  addTwoTypeSection('Redo', operationCounts.redoClicks, operationCounts.redoExecuted);
  addTwoTypeSection('Clear', operationCounts.clearClicks, operationCounts.clearExecuted);
  addTwoTypeSection('Save', operationCounts.saveClicks, operationCounts.saveExecuted);
  addTwoTypeSection('Export', operationCounts.exportClicks, operationCounts.exportExecuted);
  addTwoTypeSection('Import', operationCounts.importClicks, operationCounts.importExecuted);
  addTwoTypeSection('Toggle Selected', operationCounts.toggleSelectedClicks, operationCounts.toggleSelectedExecuted);
  addTwoTypeSection('Toggle Stroke List', operationCounts.toggleStrokeListClicks, operationCounts.toggleStrokeListExecuted);
  addTwoTypeSection('Show Inactive', operationCounts.showInactiveClicks, operationCounts.showInactiveExecuted);

  addSingleTypeSection('Snapshot Switch', operationCounts.snapshotSwitches);
  addSingleTypeSection('Toggle Active', operationCounts.toggleActiveHistory);
  addSingleTypeSection('Stroke Drawn', operationCounts.strokesDrawn);

  // 保存
  const bom = new Uint8Array([0xEF, 0xBB, 0xBF]);
  const blob = new Blob([bom, csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `operation-log-${new Date().toISOString()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}



const exportCsvBtn = document.getElementById('exportCsvBtn');
exportCsvBtn.addEventListener('click', exportOperationCountsAsCSV);

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

// 初期化
updateModeUI();

function syncTimelineSize() {
  timelineCanvas.style.height = canvas.clientHeight + 'px';
  drawTimeline();
}

window.addEventListener('resize', syncTimelineSize);
setTimeout(syncTimelineSize, 0);

window.toggleActive = toggleActive;