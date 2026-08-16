// -------------------------------------------------------------
// AeroMedia Media Server Client Controller (FastAPI Native)
// -------------------------------------------------------------

// --- CONFIGURATION ---
const SYSTEM_CONFIG = {
  previewDurationMs: 1000,
  pollIntervalMs: 2000, // Speed of polling logs and queue statuses
};

// --- SYSTEM LOGS CONSOLE UTILITY ---
const logsContainer = document.getElementById('console-logs-container');
function addLog(message, level = 'INFO') {
  const timestamp = new Date().toISOString().split('T')[1].substring(0, 8);
  writeLogToConsole(timestamp, level, message);
}

function writeLogToConsole(time, level, message) {
  let colorClass = 'text-gray-400';
  if (level === 'ERROR') colorClass = 'text-error';
  else if (level === 'SUCCESS') colorClass = 'text-success';
  else if (level === 'WORKER') colorClass = 'text-primary';
  else if (level === 'HTTP') colorClass = 'text-secondary';
  else if (level === 'WARNING') colorClass = 'text-warning';

  const logLine = document.createElement('div');
  logLine.className = `leading-relaxed hover:bg-neutral-800 px-1 rounded transition`;
  logLine.innerHTML = `<span class="text-neutral-content/40">[${time}]</span> <span class="${colorClass} font-bold">[${level}]</span> <span class="text-neutral-content/95">${message}</span>`;
  
  logsContainer.appendChild(logLine);
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

function clearConsoleLogs() {
  logsContainer.innerHTML = '';
  addLog('Console logs cleared by user.', 'INFO');
}

// --- STATE MANAGEMENT ---
const AppState = {
  isApiMode: false,
  currentPath: '/',
  files: {}, // Flat list of video files from API
  folders: new Set(['/']), // Set of scanned folders
  currentViewMode: 'grid', // grid or list
  selectedFilePath: null,
  activePlaybackFile: null,
  config: {
    segment_duration: 3
  },
  queueStatus: {
    active_item: null,
    pending_count: 0,
    completed_count: 0,
    total_jobs: 0
  },
  scrollHistory: {}, // Remembers scroll positions per folder
  resumePoints: {}, // Playback resume points synced from Python
  playerSubdivisionMode: false,
  playerSegmentIndex: 0,
  playerSegmentStartTime: 0,
};

// --- POLLING & DATA SYNC ---
let logsTracker = {}; // Tracks logs we've already displayed to prevent double printing
let globalPollTimer = null;

function syncWithBackend() {
  if (!AppState.isApiMode) return;

  // 1. Fetch backend logs and display them
  fetch('/api/logs')
    .then(res => res.json())
    .then(logs => {
      logs.forEach(log => {
        const logKey = `${log.time}-${log.level}-${log.message}`;
        if (!logsTracker[logKey]) {
          writeLogToConsole(log.time, log.level, log.message);
          logsTracker[logKey] = true;
        }
      });
    })
    .catch(() => {});

  // 2. Fetch worker queue status
  fetch('/api/queue')
    .then(res => res.json())
    .then(status => {
      AppState.queueStatus = status;
      updateQueueWidgetUI();
      
      const isQueueActive = status.pending_count > 0 || (status.active_item !== null);
      
      // Reload files if queue is active, or if it just transitioned from active to idle (to show final completed thumbnails)
      if (isQueueActive || wasQueueActive) {
        reloadFilesSilent();
      }
      
      wasQueueActive = isQueueActive;
    })
    .catch(() => {});

  // 3. Fetch synchronized playback resume states
  fetch('/api/resume')
    .then(res => res.json())
    .then(points => {
      AppState.resumePoints = points;
      // Partial update if video preview pane is open
      if (AppState.selectedFilePath && AppState.files[AppState.selectedFilePath]) {
        updatePreviewResumeUI(AppState.files[AppState.selectedFilePath]);
      }
    })
    .catch(() => {});
}

function reloadFilesSilent() {
  fetch('/api/files')
    .then(res => res.json())
    .then(data => {
      AppState.files = data.files;
      AppState.folders = new Set(['/', ...data.folders]);
      AppState.config = data.config || { segment_duration: 3 };
      renderMediaContent();
    })
    .catch(() => {});
}

function updateQueueWidgetUI() {
  const status = AppState.queueStatus;
  const badge = document.getElementById('worker-status-badge');
  const percentText = document.getElementById('queue-percentage');
  const progressBar = document.getElementById('queue-progress-bar');
  const countText = document.getElementById('queue-count-text');
  const speedText = document.getElementById('queue-speed-text');

  if (status.pending_count > 0 || status.active_item) {
    badge.textContent = `Worker: ${status.active_item ? 'Processing' : 'Active'}`;
    badge.parentElement.classList.replace('badge-success', 'badge-warning');
    
    // Calculate progress
    const total = status.total_jobs || 1;
    const completed = status.completed_count || 0;
    const percent = Math.min(Math.round((completed / total) * 100), 99);
    
    percentText.textContent = `${percent}%`;
    progressBar.value = percent;
    countText.textContent = `${status.pending_count} files remaining`;
    speedText.textContent = `Extracting frames...`;
  } else {
    badge.textContent = 'Worker Idle';
    badge.parentElement.classList.replace('badge-warning', 'badge-success');
    
    percentText.textContent = '100%';
    progressBar.value = 100;
    countText.textContent = 'All tasks completed';
    speedText.textContent = '0.0 MB/s';
  }
}

// --- INITIAL LOAD CONTROLLER ---
function loadFilesystem() {
  addLog('Querying FastAPI local server endpoints...', 'HTTP');

  fetch('/api/files')
    .then(res => {
      if (!res.ok) throw new Error('Server returned error response');
      return res.json();
    })
    .then(data => {
      AppState.isApiMode = true;
      AppState.files = data.files;
      AppState.folders = new Set(['/', ...data.folders]);
      AppState.config = data.config || { segment_duration: 3 };
      
      addLog(`Connected to python backend. Real filesystem loaded containing ${Object.keys(data.files).length} media files.`, 'SUCCESS');
      
      // Start polling sync
      if (globalPollTimer) clearInterval(globalPollTimer);
      globalPollTimer = setInterval(syncWithBackend, SYSTEM_CONFIG.pollIntervalMs);
      syncWithBackend(); // run once immediately
      
      // Initialize view
      renderSidebarFolderTree();
      navigateTo('/');
    })
    .catch(err => {
      AppState.isApiMode = false;
      addLog(`FastAPI server unreachable: ${err.message}. Showing mock data showcase instead.`, 'WARNING');
      seedMockShowcase();
    });
}

// --- STANDALONE OFFLINE MOCK DATA SEEDER ---
function seedMockShowcase() {
  addLog('Generating simulated nested filesystem...', 'INFO');
  
  // Set up categories and directory roots
  const categories = ['Sci-Fi', 'Nature', 'Documentaries', 'Lectures', 'Tutorials'];
  AppState.folders = new Set(['/']);
  AppState.files = {};
  
  // Mock folder creation
  categories.forEach(cat => {
    AppState.folders.add(`/${cat}`);
    AppState.folders.add(`/${cat}/Series`);
    AppState.folders.add(`/${cat}/Movies`);
    AppState.folders.add(`/${cat}/Series/Season 01`);
  });
  
  // Create 10-layer deeply nested folder
  AppState.folders.add('/Deeply');
  AppState.folders.add('/Deeply/Nested');
  AppState.folders.add('/Deeply/Nested/Folder');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five/Level-Six');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five/Level-Six/Level-Seven');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five/Level-Six/Level-Seven/Level-Eight');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five/Level-Six/Level-Seven/Level-Eight/Level-Nine');
  AppState.folders.add('/Deeply/Nested/Folder/Level-Four/Level-Five/Level-Six/Level-Seven/Level-Eight/Level-Nine/Level-Ten');

  // Insert mock video files (1,000+ files)
  const videoNames = ['Galaxy Exploration', 'Mountain Wildlife', 'Data Architecture', 'FastAPI Guide', 'Cyberpunk Cityscape', 'Aero Dynamics'];
  
  for (let i = 0; i < 1010; i++) {
    const isCurated = i < 3;
    let dir = '/';
    if (!isCurated) {
      // Pick random folder
      const listFolders = Array.from(AppState.folders).filter(f => f !== '/');
      dir = listFolders[Math.floor(Math.random() * listFolders.length)];
    } else {
      dir = '/Sci-Fi/Movies';
    }

    const name = isCurated 
      ? ['Blade_Runner_2049.mp4', 'Interstellar_Space.mp4', 'Planet_Earth_Leopard.mp4'][i] 
      : `${videoNames[Math.floor(Math.random() * videoNames.length)]} (Part ${i}).mp4`;
      
    const fullPath = (dir === '/' ? '' : dir) + '/' + name;
    
    // Pick standard sizes (1GB - 20GB)
    const size = Math.floor(Math.random() * (19 * 1024 * 1024 * 1024)) + (1024 * 1024 * 1024);
    const duration = Math.floor(Math.random() * 6000) + 1200;

    AppState.files[fullPath] = {
      name: name,
      dir: dir,
      fullPath: fullPath,
      size: size,
      duration: duration,
      thumbnail: null,
      thumbnailStatus: 'pending',
      preview: null,
      resolution: '1080p (H.264)',
      audio: 'AAC Stereo'
    };
  }

  addLog(`Showcase Mode: Generated ${Object.keys(AppState.files).length} mock videos across ${AppState.folders.size} directories.`, 'SUCCESS');
  
  document.getElementById('total-folders-count').textContent = AppState.folders.size;
  renderSidebarFolderTree();
  navigateTo('/');
}

// Helper: Format bytes to human readable sizes
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Helper: Format seconds to time string (HH:MM:SS)
function formatSeconds(totalSecs) {
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  return [
    h.toString().padStart(2, '0'),
    m.toString().padStart(2, '0'),
    s.toString().padStart(2, '0')
  ].join(':');
}

// --- RENDER SIDEBAR FOLDER TREE ---
function renderSidebarFolderTree() {
  const container = document.getElementById('sidebar-folder-tree');
  container.innerHTML = '';

  const sortedFolders = Array.from(AppState.folders).sort();

  // Map flat array of paths to nested objects
  const treeRoot = {};
  sortedFolders.forEach(path => {
    if (path === '/') return;
    const parts = path.split('/').filter(Boolean);
    let current = treeRoot;
    parts.forEach(part => {
      if (!current[part]) {
        current[part] = { _path: (current._path || '') + '/' + part, children: {} };
      }
      current = current[part].children;
    });
  });

  function makeFolderNodeHTML(name, node, depth = 0) {
    const childKeys = Object.keys(node.children);
    const hasChildren = childKeys.length > 0;
    const path = node._path;
    const paddingLeft = `${depth * 12 + 6}px`;

    let element = document.createElement('div');
    element.className = 'w-full';

    let row = document.createElement('div');
    row.className = `flex items-center gap-1.5 py-1 px-2 rounded-lg cursor-pointer text-xs font-medium transition hover:bg-base-200 ${AppState.currentPath === path ? 'bg-primary/10 text-primary hover:bg-primary/20' : 'text-base-content/80'}`;
    row.style.paddingLeft = paddingLeft;
    row.innerHTML = `
      <i data-lucide="${hasChildren ? 'chevron-right' : 'folder'}" class="w-3.5 h-3.5 opacity-60"></i>
      <i data-lucide="folder" class="w-3.5 h-3.5 text-secondary"></i>
      <span class="truncate pr-2">${name}</span>
    `;

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      navigateTo(path);
    });

    element.appendChild(row);

    if (hasChildren) {
      const childContainer = document.createElement('div');
      childContainer.className = 'hidden flex flex-col mt-0.5';
      childKeys.sort().forEach(childKey => {
        childContainer.appendChild(makeFolderNodeHTML(childKey, node.children[childKey], depth + 1));
      });
      element.appendChild(childContainer);

      const chevron = row.querySelector('[data-lucide="chevron-right"]');
      if (chevron) {
        chevron.addEventListener('click', (e) => {
          e.stopPropagation();
          const isCollapsed = childContainer.classList.toggle('hidden');
          chevron.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(90deg)';
        });
      }
    }

    return element;
  }

  // Root directory link
  const rootNode = document.createElement('div');
  rootNode.className = `flex items-center gap-1.5 py-1.5 px-2 rounded-lg cursor-pointer text-xs font-bold transition hover:bg-base-200 ${AppState.currentPath === '/' ? 'bg-primary/10 text-primary' : 'text-base-content/90'}`;
  rootNode.innerHTML = `
    <i data-lucide="hard-drive" class="w-3.5 h-3.5 text-primary"></i>
    <span>Root Media Directory</span>
  `;
  rootNode.addEventListener('click', () => navigateTo('/'));
  container.appendChild(rootNode);

  const rootChildrenContainer = document.createElement('div');
  rootChildrenContainer.className = 'flex flex-col mt-0.5';
  Object.keys(treeRoot).sort().forEach(key => {
    rootChildrenContainer.appendChild(makeFolderNodeHTML(key, treeRoot[key], 1));
  });
  container.appendChild(rootChildrenContainer);

  document.getElementById('total-folders-count').textContent = AppState.folders.size;
  lucide.createIcons();
}

// --- FILE SYSTEM NAVIGATION CONTROLLER ---
function navigateTo(targetPath) {
  const container = document.getElementById('media-content-container');
  if (container) {
    AppState.scrollHistory[AppState.currentPath] = container.scrollTop;
  }

  AppState.currentPath = targetPath;
  window.location.hash = targetPath;

  renderBreadcrumbs();
  renderMediaContent();
  renderSidebarFolderTree();

  setTimeout(() => {
    if (AppState.scrollHistory[targetPath] !== undefined) {
      container.scrollTop = AppState.scrollHistory[targetPath];
    } else {
      container.scrollTop = 0;
    }
  }, 50);
}

window.addEventListener('hashchange', () => {
  const hashPath = window.location.hash.substring(1) || '/';
  if (AppState.currentPath !== hashPath) {
    navigateTo(hashPath);
  }
});

function renderBreadcrumbs() {
  const container = document.getElementById('path-breadcrumbs');
  container.innerHTML = '';
  const ul = document.createElement('ul');
  
  const rootLi = document.createElement('li');
  rootLi.innerHTML = `<a class="flex items-center gap-1"><i data-lucide="home" class="w-3.5 h-3.5"></i> Root</a>`;
  rootLi.addEventListener('click', () => navigateTo('/'));
  ul.appendChild(rootLi);

  if (AppState.currentPath !== '/') {
    const parts = AppState.currentPath.split('/').filter(Boolean);
    let buildPath = '';
    parts.forEach((p, idx) => {
      buildPath += '/' + p;
      const li = document.createElement('li');
      const isLast = idx === parts.length - 1;
      
      if (isLast) {
        li.innerHTML = `<span class="font-semibold text-primary">${p}</span>`;
      } else {
        const localPath = buildPath;
        li.innerHTML = `<a>${p}</a>`;
        li.addEventListener('click', () => navigateTo(localPath));
      }
      ul.appendChild(li);
    });
  }
  container.appendChild(ul);
  lucide.createIcons();
}

// --- RENDER GRID/LIST MEDIA CONTENT ---
function renderMediaContent() {
  const gridContainer = document.getElementById('media-grid');
  const emptyScreen = document.getElementById('media-empty');
  gridContainer.innerHTML = '';
  
  const subFolders = Array.from(AppState.folders).filter(fPath => {
    if (fPath === '/' || fPath === AppState.currentPath) return false;
    const parts = fPath.split('/').filter(Boolean);
    const parentFolder = '/' + parts.slice(0, -1).join('/');
    return parentFolder === AppState.currentPath;
  });

  const filesInDir = Object.values(AppState.files).filter(f => f.dir === AppState.currentPath);

  if (subFolders.length === 0 && filesInDir.length === 0) {
    gridContainer.classList.add('hidden');
    emptyScreen.classList.remove('hidden');
    return;
  }
  gridContainer.classList.remove('hidden');
  emptyScreen.classList.add('hidden');

  if (AppState.currentViewMode === 'list') {
    gridContainer.className = "flex flex-col gap-2 w-full";
  } else {
    gridContainer.className = "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-6";
  }

  // Render Subfolders
  subFolders.sort().forEach(fPath => {
    const folderName = fPath.split('/').pop();
    const subFilesCount = Object.values(AppState.files).filter(f => f.dir.startsWith(fPath)).length;
    const card = document.createElement('div');
    
    if (AppState.currentViewMode === 'list') {
      card.className = "flex items-center justify-between p-3 bg-base-100 rounded-xl border border-base-300 hover:border-secondary cursor-pointer transition shadow-sm hover:shadow-md";
      card.innerHTML = `
        <div class="flex items-center gap-3">
          <div class="bg-secondary/10 p-2 rounded-lg text-secondary">
            <i data-lucide="folder" class="w-5 h-5 fill-current"></i>
          </div>
          <span class="font-bold text-sm text-base-content/85">${folderName}</span>
        </div>
        <span class="badge badge-sm badge-neutral">${subFilesCount} items</span>
      `;
    } else {
      card.className = "card bg-base-100 border border-base-200 hover:border-secondary cursor-pointer transition hover:shadow-lg relative overflow-hidden group";
      card.innerHTML = `
        <div class="card-body p-4 flex flex-col justify-between items-center text-center h-32">
          <div class="bg-secondary/15 p-4 rounded-full text-secondary mb-2 group-hover:scale-110 transition duration-300">
            <i data-lucide="folder" class="w-8 h-8 fill-current"></i>
          </div>
          <div class="w-full">
            <h4 class="font-bold text-xs truncate text-base-content/90">${folderName}</h4>
            <span class="text-[10px] text-base-content/40 font-semibold">${subFilesCount} videos</span>
          </div>
        </div>
      `;
    }

    card.addEventListener('click', () => navigateTo(fPath));
    gridContainer.appendChild(card);
  });

  // Render Videos
  filesInDir.sort((a, b) => a.name.localeCompare(b.name)).forEach(file => {
    const card = document.createElement('div');
    const resumeSec = AppState.resumePoints[file.fullPath] || 0;
    const progressPercent = Math.min(Math.round((resumeSec / file.duration) * 100), 100);
    const hasProgress = resumeSec > 10;

    let thumbHTML = '';
    if (file.thumbnailStatus === 'completed' && file.thumbnail) {
      thumbHTML = `<img src="${file.thumbnail}" class="w-full h-full object-cover">`;
    } else {
      // If we are in mock mode, trigger a delayed generation to simulate the worker
      if (!AppState.isApiMode && file.thumbnailStatus === 'pending') {
        simulateMockThumbnailGeneration(file);
      }
      thumbHTML = `
        <div class="absolute inset-0 bg-neutral-900 flex flex-col justify-center items-center p-2 text-center text-neutral-content">
          <span class="loading loading-spinner text-primary loading-xs mb-1"></span>
          <span class="text-[8px] text-gray-500 uppercase tracking-widest font-mono">Worker Queue</span>
        </div>
      `;
    }

    if (AppState.currentViewMode === 'list') {
      card.className = `flex items-center justify-between p-2.5 bg-base-100 rounded-xl border cursor-pointer transition shadow-sm hover:shadow-md ${AppState.selectedFilePath === file.fullPath ? 'border-primary bg-primary/5' : 'border-base-300 hover:border-primary'}`;
      card.innerHTML = `
        <div class="flex items-center gap-3 w-2/3">
          <div class="w-14 h-9 bg-base-300 rounded overflow-hidden flex-none relative">
            ${thumbHTML}
          </div>
          <div class="truncate">
            <h4 class="font-bold text-xs truncate text-base-content/95">${file.name}</h4>
            <span class="text-[10px] text-base-content/40">${formatBytes(file.size)} &bull; ${formatSeconds(file.duration)}</span>
          </div>
        </div>
        <div class="flex items-center gap-4">
          ${hasProgress ? `<span class="badge badge-xs badge-primary">Resume ${progressPercent}%</span>` : ''}
          <div class="text-[10px] text-base-content/50 border border-base-200 px-2 py-0.5 rounded font-bold uppercase">MP4</div>
        </div>
      `;
    } else {
      card.className = `card bg-base-100 border cursor-pointer transition hover:shadow-lg relative overflow-hidden group ${AppState.selectedFilePath === file.fullPath ? 'border-primary ring-2 ring-primary/20' : 'border-base-200 hover:border-primary'}`;
      card.innerHTML = `
        <figure class="aspect-video bg-neutral-950 relative w-full overflow-hidden flex-none">
          ${thumbHTML}
          
          <div class="absolute bottom-1 right-1 badge badge-neutral bg-black/60 text-white text-[9px] border-none font-semibold">
            ${formatSeconds(file.duration)}
          </div>
          <div class="absolute bottom-1 left-1 badge badge-neutral bg-black/60 text-white text-[9px] border-none font-semibold">
            ${formatBytes(file.size, 1)}
          </div>

          ${hasProgress ? `
            <div class="absolute top-1 right-1 badge badge-primary text-[8px] font-bold border-none uppercase">
              ${progressPercent}% Watched
            </div>
          ` : ''}

          ${hasProgress ? `
            <div class="absolute bottom-0 left-0 right-0 h-1 bg-black/30">
              <div class="bg-primary h-full" style="width: ${progressPercent}%"></div>
            </div>
          ` : ''}

          <div class="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-200">
            <div class="bg-primary/95 text-primary-content p-2 rounded-full shadow-lg">
              <i data-lucide="play" class="w-4 h-4 fill-current"></i>
            </div>
          </div>
        </figure>
        <div class="p-3.5 flex flex-col justify-between flex-1">
          <h4 class="font-bold text-xs line-clamp-2 leading-tight text-base-content/85 group-hover:text-primary transition" title="${file.name}">
            ${file.name}
          </h4>
        </div>
      `;
    }

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      selectVideo(file);
    });

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openFullscreenPlayer(file);
    });

    gridContainer.appendChild(card);
  });

  lucide.createIcons();
}

// Mock generator loop for offline showcase fallback mode
function simulateMockThumbnailGeneration(file) {
  file.thumbnailStatus = 'processing';
  const delay = Math.floor(Math.random() * 2000) + 1000;
  setTimeout(() => {
    file.thumbnailStatus = 'completed';
    // Generate SVG canvas dataurl
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1e1b4b';
    ctx.fillRect(0, 0, 160, 90);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 8px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(file.name.substring(0, 18), 80, 50);
    file.thumbnail = canvas.toDataURL('image/jpeg');
    
    // Refresh only if we are still inside this folder
    if (AppState.currentPath === file.dir) {
      renderMediaContent();
    }
  }, delay);
}

// --- SCAN TRIGGER MECHANICS ---
function triggerFolderScan() {
  const icon = document.getElementById('scan-icon');
  icon.classList.add('animate-spin');
  addLog(`Scan requested for: ${AppState.currentPath}`, 'HTTP');
  
  if (AppState.isApiMode) {
    fetch('/api/files')
      .then(res => res.json())
      .then(data => {
        AppState.files = data.files;
        AppState.folders = new Set(['/', ...data.folders]);
        renderMediaContent();
        addLog('Finished scanning media folder. Queue updated.', 'SUCCESS');
      })
      .catch(err => {
        addLog(`Scan error: ${err.message}`, 'ERROR');
      })
      .finally(() => {
        icon.classList.remove('animate-spin');
      });
  } else {
    setTimeout(() => {
      icon.classList.remove('animate-spin');
      addLog('Scan completed (Showcase fallback).', 'SUCCESS');
    }, 1000);
  }
}

// --- PREVIEW SYSTEM CONTROLLER (REAL PREVIEW vs SIMULATOR) ---
let previewCanvasTimer = null;

function selectVideo(video) {
  AppState.selectedFilePath = video.fullPath;
  renderMediaContent();

  document.getElementById('preview-video-title').textContent = video.name;
  document.getElementById('preview-video-path').textContent = video.fullPath;
  document.getElementById('preview-video-size').textContent = formatBytes(video.size);
  document.getElementById('preview-video-duration').textContent = formatSeconds(video.duration);

  updatePreviewResumeUI(video);

  const panel = document.getElementById('preview-panel');
  panel.classList.remove('hidden');

  startVideoPreview(video);
}

function updatePreviewResumeUI(video) {
  const resumeSec = AppState.resumePoints[video.fullPath] || 0;
  const progressText = document.getElementById('preview-resume-text');
  const progressBar = document.getElementById('preview-resume-progress');
  
  if (resumeSec > 0) {
    const percent = Math.min(Math.round((resumeSec / video.duration) * 100), 100);
    progressText.innerHTML = `Stopped watching at <span class="font-mono font-bold">${formatSeconds(resumeSec)}</span> (${percent}%)`;
    progressBar.value = percent;
  } else {
    progressText.textContent = "You have not started watching this video yet.";
    progressBar.value = 0;
  }
}

function getSubdivisionRatio(index) {
  let ratios = [];
  let denom = 2;
  while (ratios.length <= index) {
    for (let num = 1; num < denom; num += 2) {
      ratios.push(num / denom);
    }
    denom *= 2;
  }
  return ratios[index];
}

function startVideoPreview(video) {
  const canvas = document.getElementById('preview-canvas');
  const loader = document.getElementById('preview-loading');
  const p1 = document.getElementById('preview-player-1');
  const p2 = document.getElementById('preview-player-2');
  const timelineContainer = document.getElementById('preview-timeline-container');
  const durationText = document.getElementById('preview-original-duration');
  const timestampText = document.getElementById('preview-current-timestamp');
  const timelineDot = document.getElementById('preview-timeline-dot');

  // Stop any current running preview players
  stopPreviewEngine();

  currentPreviewVideo = video;
  currentSegmentIndex = 0;
  durationText.textContent = formatSeconds(video.duration);

  activePlayer = p1;
  inactivePlayer = p2;

  if (AppState.isApiMode && video.hash) {
    // Dynamic single segment player chain
    function playSegment(index) {
      if (!currentPreviewVideo || currentPreviewVideo.fullPath !== video.fullPath) return;

      currentSegmentIndex = index;
      const ratio = getSubdivisionRatio(index);
      const originalTime = ratio * video.duration;

      // Update UI indicators
      timestampText.textContent = formatSeconds(originalTime);
      timelineDot.style.left = `${ratio * 100}%`;

      // Assign segment path to preloaded/pre-allocated player
      activePlayer.src = `/api/preview_segment/${video.hash}/${index}`;
      activePlayer.classList.remove('hidden');
      loader.classList.add('hidden');
      timelineContainer.classList.add('hidden'); // hidden here per logic
      timelineContainer.classList.remove('hidden');
      
      activePlayer.play().catch(() => {});

      // Proactively preload next segment in the inactive player to mask seek delays
      const nextIndex = index + 1;
      inactivePlayer.src = `/api/preview_segment/${video.hash}/${nextIndex}`;
      inactivePlayer.load();

      // Triggers seamlessly on chunk completion
      activePlayer.onended = () => {
        activePlayer.classList.add('hidden');
        activePlayer.pause();
        activePlayer.src = "";
        
        // Swap roles
        const temp = activePlayer;
        activePlayer = inactivePlayer;
        inactivePlayer = temp;

        // Play next chunk
        playSegment(nextIndex);
      };
    }

    // Launch first segment
    playSegment(0);
  } else {
    // Mock simulation loop fallback
    startSimulatedPreviewFallback(video);
  }
}

function startSimulatedPreviewFallback(video) {
  const canvas = document.getElementById('preview-canvas');
  const loader = document.getElementById('preview-loading');
  const ctx = canvas.getContext('2d');

  setTimeout(() => {
    if (AppState.selectedFilePath !== video.fullPath) return;

    loader.classList.add('hidden');
    canvas.classList.remove('hidden');
    canvas.width = 480;
    canvas.height = 270;

    let frame = 0;
    function drawFrame() {
      if (AppState.selectedFilePath !== video.fullPath) return;

      ctx.fillStyle = '#0f172a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Neon visualizer bars
      ctx.fillStyle = '#a855f7';
      ctx.globalAlpha = 0.75;
      const barCount = 12;
      const barWidth = 16;
      const gap = 8;
      const startX = (canvas.width - (barCount * (barWidth + gap))) / 2;

      for (let i = 0; i < barCount; i++) {
        const phase = (frame / 15) + (i * 0.4);
        const wave = Math.abs(Math.sin(phase) * 0.5 + Math.cos(phase * 1.2) * 0.3);
        const barHeight = wave * 160 + 10;
        ctx.fillRect(startX + (i * (barWidth + gap)), canvas.height - barHeight - 40, barWidth, barHeight);
      }

      // Loop status
      const loopTimeMs = 1000;
      const elapsed = (Date.now() % loopTimeMs) / loopTimeMs;
      ctx.fillStyle = 'rgba(255,255,255,0.15)';
      ctx.fillRect(40, 240, canvas.width - 80, 4);
      ctx.fillStyle = '#a855f7';
      ctx.fillRect(40, 240, (canvas.width - 80) * elapsed, 4);

      ctx.globalAlpha = 1.0;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(`SIMULATED PREVIEW EXTRACTION`, canvas.width / 2, 35);
      
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '9px monospace';
      ctx.fillText(`Target Mid-Segment: ~${formatSeconds(video.duration / 2)}`, canvas.width / 2, 50);

      frame++;
      previewCanvasTimer = requestAnimationFrame(drawFrame);
    }
    drawFrame();
  }, 500);
}

// Global player variables
let currentPreviewVideo = null;
let currentSegmentIndex = 0;
let activePlayer = null;
let inactivePlayer = null;
let wasQueueActive = false;

function stopPreviewEngine() {
  if (previewCanvasTimer) {
    cancelAnimationFrame(previewCanvasTimer);
    previewCanvasTimer = null;
  }
  currentPreviewVideo = null;
  
  const p1 = document.getElementById('preview-player-1');
  const p2 = document.getElementById('preview-player-2');
  const loader = document.getElementById('preview-loading');
  const canvas = document.getElementById('preview-canvas');
  const timelineContainer = document.getElementById('preview-timeline-container');

  p1.pause(); p1.src = ""; p1.classList.add('hidden');
  p2.pause(); p2.src = ""; p2.classList.add('hidden');
  loader.classList.add('hidden');
  canvas.classList.add('hidden');
  timelineContainer.classList.add('hidden');
}

function closePreviewPanel() {
  stopPreviewEngine();
  AppState.selectedFilePath = null;
  document.getElementById('preview-panel').classList.add('hidden');
  renderMediaContent();
}

function resetVideoResumeState() {
  if (!AppState.selectedFilePath) return;
  const path = AppState.selectedFilePath;
  
  if (AppState.isApiMode) {
    fetch('/api/resume/reset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({path: path})
    })
    .then(res => res.json())
    .then(() => {
      addLog(`Reset database resume position for: ${path}`, 'INFO');
      AppState.resumePoints[path] = 0;
      if (AppState.files[path]) selectVideo(AppState.files[path]);
    });
  } else {
    delete AppState.resumePoints[path];
    addLog(`Reset resume state for: ${path}`, 'INFO');
    if (AppState.files[path]) selectVideo(AppState.files[path]);
  }
}

// --- FULLSCREEN VIDEO PLAYER CONTROLLER ---
const playerModal = document.getElementById('video_player_modal');
const playerVideo = document.getElementById('main-video-player');
const playerOverlay = document.getElementById('player-controls-overlay');
let playerProgressTimer = null;
let controlsTimeoutTimer = null;

function openFullscreenPlayerFromPreview() {
  if (currentPreviewVideo) {
    openFullscreenPlayer(currentPreviewVideo, true);
  }
}

function openFullscreenPlayer(file, subdivisionMode = false) {
  AppState.activePlaybackFile = file;
  AppState.playerSubdivisionMode = subdivisionMode;
  AppState.playerSegmentIndex = 0;
  AppState.playerSegmentStartTime = 0;

  document.getElementById('player-title').textContent = file.name;
  document.getElementById('player-subtitle').textContent = `Media Folder: ${file.dir}`;

  const subdivisionBadge = document.getElementById('player-subdivision-badge');
  if (subdivisionMode) {
    subdivisionBadge.classList.remove('hidden');
    AppState.playerSegmentStartTime = getSubdivisionRatio(0) * file.duration;
  } else {
    subdivisionBadge.classList.add('hidden');
  }

  // Hook up source (real streaming vs mock stream)
  if (AppState.isApiMode) {
    playerVideo.src = `/videos${file.fullPath}`;
    addLog(`Streaming media pipeline: ${file.fullPath}`, 'HTTP');
  } else {
    playerVideo.src = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    addLog('Showcase: Streaming BigBuckBunny mock video.', 'HTTP');
  }
  
  playerModal.showModal();

  // Retrieve resume point (only if not in subdivision preview mode)
  const resumeSec = subdivisionMode ? 0 : (AppState.resumePoints[file.fullPath] || 0);
  if (!subdivisionMode && resumeSec > 10) {
    document.getElementById('resume-time-str').textContent = formatSeconds(resumeSec);
    document.getElementById('resume_prompt_modal').showModal();
  } else {
    startPlayback(subdivisionMode ? AppState.playerSegmentStartTime : 0);
  }
}

function confirmResumePlayback(shouldResume) {
  document.getElementById('resume_prompt_modal').close();
  const file = AppState.activePlaybackFile;
  const resumeSec = AppState.resumePoints[file.fullPath] || 0;
  
  if (shouldResume) {
    startPlayback(resumeSec);
  } else {
    startPlayback(0);
  }
}

function startPlayback(startTimeSeconds) {
  playerVideo.currentTime = startTimeSeconds;
  playerVideo.play()
    .then(() => {
      addLog(`Playback successfully initiated.`, 'SUCCESS');
      updatePlayPauseButtonIcon(true);
      resetControlsTimeout();
    })
    .catch(err => {
      addLog(`Playback error: ${err.message}`, 'ERROR');
    });

  // Track progress and update timeline
  if (playerProgressTimer) clearInterval(playerProgressTimer);
  playerProgressTimer = setInterval(() => {
    if (playerVideo.paused || playerVideo.ended) return;
    
    // Save progress to server/storage (only if not in subdivision preview mode)
    const currentSecs = Math.round(playerVideo.currentTime);
    if (AppState.activePlaybackFile && !AppState.playerSubdivisionMode) {
      AppState.resumePoints[AppState.activePlaybackFile.fullPath] = currentSecs;
      
      if (AppState.isApiMode) {
        // Sync with FastAPI backend database
        fetch('/api/resume', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({path: AppState.activePlaybackFile.fullPath, time: currentSecs})
        }).catch(() => {});
      }
    }

    // Handle subdivision seeking logic if enabled
    if (AppState.playerSubdivisionMode) {
      const segDuration = (AppState.config && AppState.config.segment_duration) || 3;
      const elapsed = playerVideo.currentTime - AppState.playerSegmentStartTime;
      
      if (elapsed > segDuration || playerVideo.currentTime < AppState.playerSegmentStartTime) {
        // Move to the next segment
        AppState.playerSegmentIndex++;
        const nextRatio = getSubdivisionRatio(AppState.playerSegmentIndex);
        AppState.playerSegmentStartTime = nextRatio * playerVideo.duration;
        
        addLog(`Summary Tour: Seeking to segment ${AppState.playerSegmentIndex} (${Math.round(nextRatio*100)}% -> ${formatSeconds(AppState.playerSegmentStartTime)})`, 'INFO');
        playerVideo.currentTime = AppState.playerSegmentStartTime;
      }
    }

    updatePlayerTimelineUI();
  }, 1000);
}

function updatePlayerTimelineUI() {
  const current = playerVideo.currentTime;
  const total = playerVideo.duration || AppState.activePlaybackFile.duration;
  
  document.getElementById('player-time-current').textContent = formatSeconds(current);
  document.getElementById('player-time-total').textContent = formatSeconds(total);
  
  const percentage = Math.round((current / total) * 100) || 0;
  document.getElementById('player-timeline').value = percentage;
}

document.getElementById('player-timeline').addEventListener('input', (e) => {
  if (AppState.playerSubdivisionMode) {
    AppState.playerSubdivisionMode = false;
    document.getElementById('player-subdivision-badge').classList.add('hidden');
    addLog('Summary Tour deactivated via manual seek.', 'INFO');
  }
  const percent = parseInt(e.target.value);
  const total = playerVideo.duration || AppState.activePlaybackFile.duration;
  const seekTarget = (percent / 100) * total;
  
  playerVideo.currentTime = seekTarget;
  updatePlayerTimelineUI();
  resetControlsTimeout();
});

function togglePlayerPlayback() {
  if (playerVideo.paused) {
    playerVideo.play();
    updatePlayPauseButtonIcon(true);
    triggerCenterPlayIndicator(true);
  } else {
    playerVideo.pause();
    updatePlayPauseButtonIcon(false);
    triggerCenterPlayIndicator(false);
  }
  resetControlsTimeout();
}

function updatePlayPauseButtonIcon(isPlaying) {
  const icon = document.getElementById('btn-player-play-icon');
  icon.setAttribute('data-lucide', isPlaying ? 'pause' : 'play');
  lucide.createIcons();
}

function triggerCenterPlayIndicator(isPlay) {
  const icon = document.getElementById('center-play-icon');
  const panel = document.getElementById('player-center-play-indicator');
  
  icon.setAttribute('data-lucide', isPlay ? 'play' : 'pause');
  lucide.createIcons();
  
  panel.classList.remove('opacity-0', 'scale-75');
  panel.classList.add('opacity-100', 'scale-100');
  
  setTimeout(() => {
    panel.classList.remove('opacity-100', 'scale-100');
    panel.classList.add('opacity-0', 'scale-75');
  }, 400);
}

function playerForward(secs) {
  if (AppState.playerSubdivisionMode) {
    AppState.playerSubdivisionMode = false;
    document.getElementById('player-subdivision-badge').classList.add('hidden');
    addLog('Summary Tour deactivated via manual skip.', 'INFO');
  }
  playerVideo.currentTime = Math.min(playerVideo.currentTime + secs, playerVideo.duration);
  updatePlayerTimelineUI();
  resetControlsTimeout();
}

function playerRewind(secs) {
  if (AppState.playerSubdivisionMode) {
    AppState.playerSubdivisionMode = false;
    document.getElementById('player-subdivision-badge').classList.add('hidden');
    addLog('Summary Tour deactivated via manual skip.', 'INFO');
  }
  playerVideo.currentTime = Math.max(playerVideo.currentTime - secs, 0);
  updatePlayerTimelineUI();
  resetControlsTimeout();
}

// Volume Slider
const volumeSlider = document.getElementById('player-volume-slider');
volumeSlider.addEventListener('input', (e) => {
  const vol = parseInt(e.target.value) / 100;
  playerVideo.volume = vol;
  updateVolumeIcon(vol);
  resetControlsTimeout();
});

function updateVolumeIcon(vol) {
  const icon = document.getElementById('btn-player-volume-icon');
  let name = 'volume-2';
  if (vol === 0) name = 'volume-x';
  else if (vol < 0.4) name = 'volume';
  else if (vol < 0.75) name = 'volume-1';
  icon.setAttribute('data-lucide', name);
  lucide.createIcons();
}

function setPlaybackSpeed(speed) {
  playerVideo.playbackRate = speed;
  document.getElementById('player-speed-text').textContent = `${speed}x`;
  resetControlsTimeout();
}

function closeFullscreenPlayer() {
  if (playerProgressTimer) {
    clearInterval(playerProgressTimer);
    playerProgressTimer = null;
  }
  playerVideo.pause();
  playerModal.close();
  AppState.playerSubdivisionMode = false;
  document.getElementById('player-subdivision-badge').classList.add('hidden');
  
  // Refresh UI
  renderMediaContent();
  if (AppState.selectedFilePath) {
    selectVideo(AppState.files[AppState.selectedFilePath]);
  }
  AppState.activePlaybackFile = null;
}

function resetControlsTimeout() {
  playerOverlay.classList.remove('opacity-0');
  playerVideo.style.cursor = 'default';
  
  if (controlsTimeoutTimer) clearTimeout(controlsTimeoutTimer);
  controlsTimeoutTimer = setTimeout(() => {
    if (!playerVideo.paused) {
      playerOverlay.classList.add('opacity-0');
      playerVideo.style.cursor = 'none';
    }
  }, 3500);
}

playerModal.addEventListener('mousemove', resetControlsTimeout);
playerModal.addEventListener('click', (e) => {
  if (e.target.id === 'gesture-zone-center') {
    togglePlayerPlayback();
  }
});

// --- TABLET SWIPE GESTURE CONTROLS FOR PLAYER ---
let touchStartY = 0;
let initialVolumeVal = 100;
let initialBrightnessVal = 100;

function registerTabletGestures() {
  const zoneLeft = document.getElementById('gesture-zone-left');
  const zoneRight = document.getElementById('gesture-zone-right');

  zoneLeft.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
    initialVolumeVal = playerVideo.volume * 100;
    document.getElementById('gesture-indicator-left').classList.remove('opacity-0');
    resetControlsTimeout();
  });

  zoneLeft.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touchY = e.touches[0].clientY;
    const deltaY = touchStartY - touchY;
    const deltaPercent = Math.round((deltaY / window.innerHeight) * 150);
    
    let targetVolume = Math.min(Math.max(initialVolumeVal + deltaPercent, 0), 100);
    playerVideo.volume = targetVolume / 100;
    
    document.getElementById('gesture-volume-val').textContent = `${targetVolume}%`;
    volumeSlider.value = targetVolume;
    updateVolumeIcon(targetVolume / 100);
  });

  zoneLeft.addEventListener('touchend', () => {
    document.getElementById('gesture-indicator-left').classList.add('opacity-0');
  });

  zoneRight.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
    document.getElementById('gesture-indicator-right').classList.remove('opacity-0');
    resetControlsTimeout();
  });

  zoneRight.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touchY = e.touches[0].clientY;
    const deltaY = touchStartY - touchY;
    const deltaPercent = Math.round((deltaY / window.innerHeight) * 150);
    
    let targetBrightness = Math.min(Math.max(initialBrightnessVal + deltaPercent, 0), 100);
    initialBrightnessVal = targetBrightness;
    
    const opacityVal = 0.5 + (targetBrightness / 200);
    playerVideo.style.filter = `brightness(${opacityVal * 1.5})`;

    document.getElementById('gesture-brightness-val').textContent = `${targetBrightness}%`;
  });

  zoneRight.addEventListener('touchend', () => {
    document.getElementById('gesture-indicator-right').classList.add('opacity-0');
  });
}

// --- SEARCH ENGINE ---
document.getElementById('search-input').addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const gridContainer = document.getElementById('media-grid');
  const emptyScreen = document.getElementById('media-empty');
  
  if (!query) {
    renderMediaContent();
    return;
  }

  gridContainer.innerHTML = '';
  const matches = Object.values(AppState.files).filter(f => f.name.toLowerCase().includes(query));

  if (matches.length === 0) {
    gridContainer.classList.add('hidden');
    emptyScreen.classList.remove('hidden');
    emptyScreen.querySelector('h3').textContent = 'No search matches found';
    emptyScreen.querySelector('p').textContent = 'Check spelling or try a different keyword.';
    return;
  }

  gridContainer.classList.remove('hidden');
  emptyScreen.classList.add('hidden');

  matches.forEach(file => {
    const card = document.createElement('div');
    card.className = `card bg-base-100 border cursor-pointer transition hover:shadow-lg relative overflow-hidden group ${AppState.selectedFilePath === file.fullPath ? 'border-primary ring-2 ring-primary/20' : 'border-base-200'}`;
    
    let thumbHTML = '';
    if (file.thumbnailStatus === 'completed' && file.thumbnail) {
      thumbHTML = `<img src="${file.thumbnail}" class="w-full h-full object-cover">`;
    } else {
      thumbHTML = `<div class="absolute inset-0 bg-neutral-900 flex items-center justify-center text-neutral-content text-[10px]"><span class="loading loading-spinner text-primary loading-xs"></span></div>`;
    }

    card.innerHTML = `
      <figure class="aspect-video bg-neutral-950 relative w-full overflow-hidden flex-none">
        ${thumbHTML}
        <div class="absolute bottom-1 right-1 badge badge-neutral bg-black/60 text-white text-[9px] border-none font-semibold">
          ${formatSeconds(file.duration)}
        </div>
      </figure>
      <div class="p-3">
        <h4 class="font-bold text-xs line-clamp-2 leading-tight text-base-content/85 group-hover:text-primary transition">
          ${file.name}
        </h4>
        <span class="text-[9px] text-base-content/40 truncate block mt-1">${file.dir}</span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      e.stopPropagation();
      selectVideo(file);
    });

    card.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      openFullscreenPlayer(file);
    });

    gridContainer.appendChild(card);
  });

  lucide.createIcons();
});

// --- GRID/LIST VIEW TOGGLERS ---
document.getElementById('btn-grid-view').addEventListener('click', () => {
  AppState.currentViewMode = 'grid';
  document.getElementById('btn-grid-view').classList.add('btn-active');
  document.getElementById('btn-list-view').classList.remove('btn-active');
  renderMediaContent();
});

document.getElementById('btn-list-view').addEventListener('click', () => {
  AppState.currentViewMode = 'list';
  document.getElementById('btn-list-view').classList.add('btn-active');
  document.getElementById('btn-grid-view').classList.remove('btn-active');
  renderMediaContent();
});

// --- HOTKEY TRIGGERS ---
window.addEventListener('keydown', (e) => {
  if (playerModal.open) {
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlayerPlayback();
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      playerForward(10);
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      playerRewind(10);
    } else if (e.code === 'Escape') {
      closeFullscreenPlayer();
    }
  }
});

// --- INITIALIZE APPLICATION ---
window.addEventListener('DOMContentLoaded', () => {
  loadFilesystem();
});
