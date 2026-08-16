import os
import sys
import json
import hashlib
import shutil
import subprocess
import threading
import queue
import logging
from typing import List, Dict, Optional
from datetime import datetime

from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import socket

def get_local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(('10.255.255.255', 1))
        IP = s.getsockname()[0]
    except Exception:
        IP = '127.0.0.1'
    finally:
        s.close()
    return IP

# Config and global states
PORT = 8080
SEGMENT_DURATION = 3
STATIC_DIR = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))
MEDIA_DIR = None

# Cache is stored in the user's home folder to ensure write access and persist settings across updates
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".caddy-video-server")
THUMB_DIR = os.path.join(CACHE_DIR, "thumbnails")
PREVIEW_DIR = os.path.join(CACHE_DIR, "previews")

# Create cache dirs
os.makedirs(THUMB_DIR, exist_ok=True)
os.makedirs(PREVIEW_DIR, exist_ok=True)

# In-memory logging utility for frontend console logs
sys_logs = []
def log_message(msg: str, level: str = "INFO"):
    timestamp = datetime.now().strftime("%H:%M:%S")
    log_entry = {"time": timestamp, "level": level, "message": msg}
    sys_logs.append(log_entry)
    # Keep logs capped to last 100 entries to prevent memory leak
    if len(sys_logs) > 100:
        sys_logs.pop(0)
    # Also print to stdout
    print(f"[{timestamp}] [{level}] {msg}")

# Detect FFmpeg binaries
FFMPEG_PATH = shutil.which("ffmpeg")
FFPROBE_PATH = shutil.which("ffprobe")

if FFMPEG_PATH:
    log_message(f"FFmpeg binary detected: {FFMPEG_PATH}", "INFO")
else:
    log_message("FFmpeg binary NOT found. Previews/thumbnails will fallback to placeholders.", "WARNING")

if FFPROBE_PATH:
    log_message(f"FFprobe binary detected: {FFPROBE_PATH}", "INFO")
else:
    log_message("FFprobe binary NOT found. Durations will be estimated.", "WARNING")

# Resume Database (Simple JSON file)
RESUME_DB_PATH = os.path.join(CACHE_DIR, "resume_db.json")
def load_resume_db() -> Dict[str, int]:
    if os.path.exists(RESUME_DB_PATH):
        try:
            with open(RESUME_DB_PATH, "r") as f:
                return json.load(f)
        except Exception as e:
            log_message(f"Failed to read resume database: {e}", "ERROR")
    return {}

def save_resume_db(db: Dict[str, int]):
    try:
        with open(RESUME_DB_PATH, "w") as f:
            json.dump(db, f)
    except Exception as e:
        log_message(f"Failed to write resume database: {e}", "ERROR")

# Thread-safe Background Extraction Worker
task_queue = queue.Queue()
queue_status = {
    "active_item": None,
    "pending_count": 0,
    "completed_count": 0,
    "total_jobs": 0
}

def generate_video_hash(relative_path: str) -> str:
    """Creates a unique hash of the path for safe cache naming."""
    return hashlib.md5(relative_path.encode('utf-8')).hexdigest()

def extract_thumbnail_ffmpeg(video_path: str, output_path: str, duration: int) -> bool:
    if not FFMPEG_PATH:
        return False
    
    # Seek to 10% of duration (minimum 2 seconds in case duration is short)
    seek_time = max(2, int(duration * 0.1))
    
    cmd = [
        FFMPEG_PATH, "-y",
        "-ss", str(seek_time),
        "-i", video_path,
        "-vframes", "1",
        "-q:v", "3",  # High quality jpeg
        "-vf", "scale=320:-2",
        output_path
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15)
        if res.returncode == 0:
            return True
        else:
            log_message(f"FFmpeg thumbnail extract failed for {os.path.basename(video_path)}: {res.stderr.strip()}", "ERROR")
    except Exception as e:
        log_message(f"Error running FFmpeg for thumbnail extraction: {e}", "ERROR")
    return False

def get_subdivision_midpoints(duration: int, count: int = 60) -> list[float]:
    """
    Dynamically calculates time midpoints based on dyadic subdivision ratios
    for any arbitrary count of segments.
    """
    count = min(count, duration)
    if count <= 0:
        return [0.0]
        
    ratios = []
    denom = 2
    while len(ratios) < count:
        for num in range(1, denom, 2):
            ratios.append(num / denom)
            if len(ratios) >= count:
                break
        denom *= 2
        
    midpoints = []
    for r in ratios:
        mid = r * duration
        # Clamp seek to prevent overflow past end of video taking segment duration into account
        mid = min(mid, duration - SEGMENT_DURATION - 0.5)
        mid = max(0.0, mid)
        midpoints.append(mid)
    return midpoints

def extract_preview_ffmpeg(video_path: str, output_path: str, duration: int) -> bool:
    if not FFMPEG_PATH:
        return False
    
    midpoints = get_subdivision_midpoints(duration, count=60)
            
    # Build the multi-input command
    cmd = [FFMPEG_PATH, "-y"]
    for mid in midpoints:
        cmd.extend(["-ss", f"{mid:.2f}", "-t", "1", "-i", video_path])
        
    # Build filter complex for concat and scale
    filter_inputs = "".join(f"[{i}:v]" for i in range(len(midpoints)))
    filter_str = f"{filter_inputs}concat=n={len(midpoints)}:v=1:a=0,scale=480:-2[outv]"
    
    cmd.extend([
        "-filter_complex", filter_str,
        "-map", "[outv]",
        "-c:v", "libx264",
        "-preset", "superfast",
        "-crf", "28",
        "-an",
        output_path
    ])
    
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=40)
        if res.returncode == 0:
            return True
        else:
            log_message(f"FFmpeg preview extract failed for {os.path.basename(video_path)}: {res.stderr.strip()}", "ERROR")
    except Exception as e:
        log_message(f"Error running FFmpeg for preview extraction: {e}", "ERROR")
    return False

def worker_thread_loop():
    global queue_status
    log_message("Background extraction worker thread started.", "INFO")
    
    while True:
        try:
            task = task_queue.get()
            if task is None:
                # Poison pill to shutdown thread
                break
                
            file_name = task["name"]
            file_path = task["abs_path"]
            file_hash = task["hash"]
            duration = task["duration"]
            
            queue_status["active_item"] = file_name
            queue_status["pending_count"] = task_queue.qsize()
            
            thumb_out = os.path.join(THUMB_DIR, f"{file_hash}.jpg")
            preview_out = os.path.join(PREVIEW_DIR, f"{file_hash}.mp4")
            
            # 1. Process Thumbnail if missing
            if not os.path.exists(thumb_out):
                log_message(f"Generating thumbnail for: {file_name}", "WORKER")
                success = extract_thumbnail_ffmpeg(file_path, thumb_out, duration)
                if success:
                    log_message(f"Thumbnail created successfully: {file_name}", "WORKER")
                else:
                    log_message(f"Failed to generate thumbnail for: {file_name}", "ERROR")
            
            queue_status["completed_count"] += 1
            queue_status["pending_count"] = task_queue.qsize()
            queue_status["active_item"] = None  # Reset active item to avoid constant client polling when idle
            task_queue.task_done()
            
        except Exception as e:
            log_message(f"Queue worker encountered error: {e}", "ERROR")
            
    queue_status["active_item"] = None
    log_message("Background extraction worker thread stopped.", "INFO")

# Start background worker
worker_thread = threading.Thread(target=worker_thread_loop, daemon=True)
worker_thread.start()

# --- FASTAPI SERVER DEFINITION ---
app = FastAPI(title="AeroMedia Local Media Server")

# Allow CORS for direct connections
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def get_video_duration_ffprobe(filepath: str) -> int:
    """Uses ffprobe to extract real duration, falls back to estimation."""
    if not FFPROBE_PATH:
        # Fallback estimation based on average 3 Mbps compression
        try:
            size = os.path.getsize(filepath)
            return max(60, int(size / (375 * 1024)))
        except OSError:
            return 3600
            
    cmd = [
        FFPROBE_PATH, "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filepath
    ]
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=3)
        if res.returncode == 0:
            return int(float(res.stdout.strip()))
    except Exception:
        pass
    
    # Second fallback
    try:
        size = os.path.getsize(filepath)
        return max(60, int(size / (375 * 1024)))
    except OSError:
        return 3600

def scan_media_directory(media_path: str):
    """
    Scans the media path recursively up to 10 layers deep, collecting folder structure
    and video details.
    """
    folders = set()
    files = {}
    
    for root, dirs, filenames in os.walk(media_path):
        rel_path = os.path.relpath(root, media_path)
        if rel_path == '.':
            rel_dir = '/'
            depth = 0
        else:
            rel_dir = '/' + rel_path.replace(os.path.sep, '/')
            depth = rel_path.count(os.path.sep) + 1
            
        if depth > 10:
            continue
            
        if rel_dir != '/':
            folders.add(rel_dir)
            parts = rel_dir.split('/')
            for idx in range(2, len(parts)):
                parent = '/' + '/'.join(parts[1:idx])
                folders.add(parent)
                
        for filename in filenames:
            if filename.lower().endswith(('.mp4', '.m4v', '.mov', '.mkv')):
                full_path = os.path.join(root, filename)
                rel_file_path = (rel_dir if rel_dir != '/' else '') + '/' + filename
                file_hash = generate_video_hash(rel_file_path)
                
                try:
                    size = os.path.getsize(full_path)
                except OSError:
                    size = 0
                
                duration = get_video_duration_ffprobe(full_path)
                
                # Check if thumbnails/previews are generated
                thumb_url = f"/cache/thumbnails/{file_hash}.jpg" if os.path.exists(os.path.join(THUMB_DIR, f"{file_hash}.jpg")) else None
                preview_url = f"/cache/previews/{file_hash}.mp4" if os.path.exists(os.path.join(PREVIEW_DIR, f"{file_hash}.mp4")) else None
                
                files[rel_file_path] = {
                    "name": filename,
                    "dir": rel_dir,
                    "fullPath": rel_file_path,
                    "hash": file_hash,
                    "size": size,
                    "duration": duration,
                    "thumbnail": thumb_url,
                    "thumbnailStatus": "completed" if thumb_url else "pending",
                    "preview": preview_url,
                    "resolution": "1080p (H.264)" if filename.lower().endswith('.mp4') else "Direct Container",
                    "audio": "AAC Audio"
                }
    return sorted(list(folders)), files

# REST API Endpoints
@app.get("/api/files")
def api_get_files():
    """Scans the directory recursively and returns real folders and files metadata."""
    if not MEDIA_DIR:
        raise HTTPException(status_code=500, detail="Media directory not set")
        
    log_message("API request: GET /api/files - Scanning file system.", "HTTP")
    folders, files = scan_media_directory(MEDIA_DIR)
    
    # Automatically queue if thumbnails are missing and ffmpeg is available
    for rel_file_path, file in files.items():
        if FFMPEG_PATH and not file["thumbnail"]:
            file_hash = generate_video_hash(rel_file_path)
            full_path = os.path.join(MEDIA_DIR, rel_file_path.lstrip('/'))
            
            already_queued = False
            for q_item in list(task_queue.queue):
                if q_item["hash"] == file_hash:
                    already_queued = True
                    break
            if not already_queued:
                task_queue.put({
                    "name": file["name"],
                    "abs_path": full_path,
                    "hash": file_hash,
                    "duration": file["duration"]
                })
                        
    queue_status["pending_count"] = task_queue.qsize()
    queue_status["total_jobs"] = queue_status["completed_count"] + queue_status["pending_count"]
    
    return {
        "folders": folders,
        "files": files,
        "config": {
            "segment_duration": SEGMENT_DURATION
        }
    }

@app.get("/api/queue")
def api_get_queue():
    """Returns background worker queue details."""
    queue_status["pending_count"] = task_queue.qsize()
    return queue_status

@app.get("/api/logs")
def api_get_logs():
    """Returns log entries for logging display."""
    return sys_logs

@app.get("/api/resume")
def api_get_resume():
    """Returns playback resume states."""
    return load_resume_db()

@app.post("/api/resume")
async def api_post_resume(request: Request):
    """Saves playback resume positions."""
    body = await request.json()
    path = body.get("path")
    time_sec = body.get("time")
    
    if path is None or time_sec is None:
        raise HTTPException(status_code=400, detail="Invalid payload")
        
    db = load_resume_db()
    db[path] = int(time_sec)
    save_resume_db(db)
    return {"status": "ok"}

@app.post("/api/resume/reset")
async def api_post_resume_reset(request: Request):
    """Resets playback resume position for a file."""
    body = await request.json()
    path = body.get("path")
    if not path:
        raise HTTPException(status_code=400, detail="Invalid payload")
        
    db = load_resume_db()
    if path in db:
        del db[path]
        save_resume_db(db)
    return {"status": "ok"}

def get_subdivision_ratio(index: int) -> float:
    ratios = []
    denom = 2
    while len(ratios) <= index:
        for num in range(1, denom, 2):
            ratios.append(num / denom)
        denom *= 2
    return ratios[index]

@app.get("/api/preview_segment/{file_hash}/{segment_index}")
def get_preview_segment(file_hash: str, segment_index: int):
    """
    Extracts exactly a single segment_duration clip starting at the dyadic midpoint
    of the segment index. Zero latency, on-demand, and cached.
    """
    if not MEDIA_DIR:
        raise HTTPException(status_code=500, detail="Media directory not set")

    segment_cache_file = os.path.join(PREVIEW_DIR, f"{file_hash}_{segment_index}.mp4")
    if os.path.exists(segment_cache_file):
        return FileResponse(segment_cache_file, media_type="video/mp4")

    # Find the corresponding file in MEDIA_DIR
    target_abs_path = None
    target_duration = 3600
    
    for root, dirs, filenames in os.walk(MEDIA_DIR):
        rel_path = os.path.relpath(root, MEDIA_DIR)
        rel_dir = '/' if rel_path == '.' else '/' + rel_path.replace(os.path.sep, '/')
        depth = rel_path.count(os.path.sep) + 1 if rel_path != '.' else 0
        if depth > 10:
            continue
        for filename in filenames:
            if filename.lower().endswith(('.mp4', '.m4v', '.mov', '.mkv')):
                rel_file_path = (rel_dir if rel_dir != '/' else '') + '/' + filename
                if generate_video_hash(rel_file_path) == file_hash:
                    target_abs_path = os.path.join(root, filename)
                    target_duration = get_video_duration_ffprobe(target_abs_path)
                    break
        if target_abs_path:
            break

    if not target_abs_path:
        raise HTTPException(status_code=404, detail="Video file not found")

    if not FFMPEG_PATH:
        raise HTTPException(status_code=501, detail="FFmpeg not installed")

    # Calculate midpoint
    ratio = get_subdivision_ratio(segment_index)
    seek_time = ratio * target_duration
    seek_time = min(seek_time, target_duration - SEGMENT_DURATION - 0.5)
    seek_time = max(0.0, seek_time)

    # Extract single segment
    cmd = [
        FFMPEG_PATH, "-y",
        "-ss", f"{seek_time:.2f}",
        "-t", str(SEGMENT_DURATION),
        "-i", target_abs_path,
        "-c:v", "libx264",
        "-preset", "superfast",
        "-crf", "28",
        "-an",
        "-vf", "scale=480:-2",
        segment_cache_file
    ]
    
    try:
        res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10)
        if res.returncode == 0:
            return FileResponse(segment_cache_file, media_type="video/mp4")
        else:
            log_message(f"FFmpeg single segment extract failed: {res.stderr.strip()}", "ERROR")
            raise HTTPException(status_code=500, detail="FFmpeg extraction failed")
    except Exception as e:
        log_message(f"Error running FFmpeg: {e}", "ERROR")
        raise HTTPException(status_code=500, detail=str(e))

# Serving the raw video files with seek support
@app.get("/videos/{video_path:path}")
def get_video_stream(video_path: str):
    """
    Streams the raw video file. Starlette's FileResponse automatically processes
    HTTP Range requests for scrubbing, seeking, and responsive tablet playback.
    """
    abs_filepath = os.path.join(MEDIA_DIR, video_path.lstrip("/"))
    if not os.path.exists(abs_filepath) or os.path.isdir(abs_filepath):
        log_message(f"HTTP GET /videos/{video_path} failed: file not found", "ERROR")
        raise HTTPException(status_code=404, detail="Video file not found")
        
    # Check Range header in request for logging
    return FileResponse(abs_filepath, media_type="video/mp4")

# Static files routes
app.mount("/cache", StaticFiles(directory=CACHE_DIR), name="cache")
app.mount("/thumbnails", StaticFiles(directory=os.path.join(STATIC_DIR, "thumbnails")), name="thumbnails")

# Serve the static SPA UI
@app.get("/app.js")
def get_app_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"))

@app.get("/")
def get_index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

def main():
    global MEDIA_DIR, PORT, SEGMENT_DURATION
    import argparse
    
    parser = argparse.ArgumentParser(description="AeroMedia Local Media Server")
    parser.add_argument("media_directory", help="Input directory of nested MP4s")
    parser.add_argument("-d", "--segment-duration", type=int, default=3, 
                        help="Duration in seconds of each preview segment (default: 3)")
    parser.add_argument("-p", "--port", type=int, default=8080, 
                        help="Port to bind the server to (default: 8080)")
    args = parser.parse_args()
    
    MEDIA_DIR = os.path.abspath(args.media_directory)
    if not os.path.exists(MEDIA_DIR) or not os.path.isdir(MEDIA_DIR):
        print(f"Error: Directory '{MEDIA_DIR}' does not exist.")
        sys.exit(1)
        
    PORT = args.port
    SEGMENT_DURATION = args.segment_duration

    local_ip = get_local_ip()
    log_message("=" * 60)
    log_message("      AeroMedia - Local Media Server (FastAPI)")
    log_message("=" * 60)
    log_message(f"Web Directory:       {STATIC_DIR}")
    log_message(f"Media Source Path:   {MEDIA_DIR}")
    log_message(f"Segment Duration:    {SEGMENT_DURATION}s")
    log_message(f"Local Access:        http://localhost:{PORT}")
    log_message(f"LAN Access:          http://{local_ip}:{PORT}")
    log_message("=" * 60)
    
    # Hide standard uvicorn logging or control it so it doesn't clutter stdout if we print custom logs
    log_config = uvicorn.config.LOGGING_CONFIG
    log_config["formatters"]["default"]["fmt"] = "[%(asctime)s] [UVICORN] %(message)s"
    
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_config=log_config)

if __name__ == '__main__':
    main()
