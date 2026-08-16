import os
import shutil
import pytest
from fastapi.testclient import TestClient

# Since we installed media-server in editable mode, we can import it directly
import media_server
from media_server import (
    app,
    generate_video_hash,
    scan_media_directory,
    load_resume_db,
    save_resume_db,
    get_local_ip,
)

# Initialize TestClient
client = TestClient(app)

@pytest.fixture(autouse=True)
def setup_and_teardown_cache(tmp_path):
    """
    Redirects cache directories and resume database to the temporary test path
    to ensure isolation and prevent polluting production caches.
    """
    original_cache = media_server.CACHE_DIR
    original_thumb = media_server.THUMB_DIR
    original_preview = media_server.PREVIEW_DIR
    original_resume_db = media_server.RESUME_DB_PATH
    
    # Configure test paths
    test_cache = os.path.join(tmp_path, "cache")
    media_server.CACHE_DIR = test_cache
    media_server.THUMB_DIR = os.path.join(test_cache, "thumbnails")
    media_server.PREVIEW_DIR = os.path.join(test_cache, "previews")
    media_server.RESUME_DB_PATH = os.path.join(test_cache, "resume_db.json")
    
    os.makedirs(media_server.THUMB_DIR, exist_ok=True)
    os.makedirs(media_server.PREVIEW_DIR, exist_ok=True)
    
    yield
    
    # Restore original paths
    media_server.CACHE_DIR = original_cache
    media_server.THUMB_DIR = original_thumb
    media_server.PREVIEW_DIR = original_preview
    media_server.RESUME_DB_PATH = original_resume_db

@pytest.fixture
def mock_media_folder(tmp_path):
    """Creates a temporary nested mock directory representing the media root."""
    media_root = tmp_path / "media_root"
    os.makedirs(media_root, exist_ok=True)
    
    # Root level video
    root_video = media_root / "root_video.mp4"
    root_video.write_bytes(b"\x00" * 1024 * 1024) # 1 MB of mock bytes
    
    # Layer 1 video
    layer1_dir = media_root / "Sci-Fi"
    os.makedirs(layer1_dir, exist_ok=True)
    layer1_video = layer1_dir / "sci_fi_movie.mp4"
    layer1_video.write_bytes(b"\x00" * 2 * 1024 * 1024) # 2 MB of mock bytes
    
    # Level 11 nested directory (Should be ignored by the 10-layer depth constraint)
    deep_path = media_root
    for i in range(1, 13): # 12 nested folder layers
        deep_path = deep_path / f"Level-{i}"
    os.makedirs(deep_path, exist_ok=True)
    deep_video = deep_path / "ignored_deep_video.mp4"
    deep_video.write_bytes(b"\x00" * 1024)
    
    # Non-video files (Should be ignored by scan_media_directory)
    txt_file = media_root / "info.txt"
    txt_file.write_text("Plain text documentation")
    
    # Temporary mock target directory injection
    media_server.MEDIA_DIR = str(media_root)
    
    return media_root

def test_generate_video_hash():
    # Verify hash integrity and repeatability
    path_a = "/Sci-Fi/Movies/Interstellar.mp4"
    path_b = "/Sci-Fi/Movies/Interstellar.mp4"
    path_c = "/Nature/PlanetEarth.mp4"
    
    hash_a = generate_video_hash(path_a)
    hash_b = generate_video_hash(path_b)
    hash_c = generate_video_hash(path_c)
    
    assert hash_a == hash_b
    assert hash_a != hash_c
    assert len(hash_a) == 32 # MD5 hash length string

def test_get_local_ip():
    ip = get_local_ip()
    assert isinstance(ip, str)
    assert len(ip.split('.')) == 4 # IPv4 format

def test_scan_media_directory(mock_media_folder):
    folders, files = scan_media_directory(str(mock_media_folder))
    
    # Assert folders matches expected depths
    assert "/Sci-Fi" in folders
    # Ensure Level-11 & 12 folders are omitted due to 10 layers constraint
    assert not any(f.endswith("Level-11") or f.endswith("Level-12") for f in folders)
    
    # Assert correct videos scanned
    assert "/root_video.mp4" in files
    assert "/Sci-Fi/sci_fi_movie.mp4" in files
    
    # Assert excluded files
    assert "/info.txt" not in files
    # Ensure deep video >10 levels was ignored
    assert not any("ignored_deep_video" in key for key in files.keys())
    
    # Check details scanned
    root_vid = files["/root_video.mp4"]
    assert root_vid["size"] == 1024 * 1024
    assert root_vid["name"] == "root_video.mp4"
    assert root_vid["dir"] == "/"
    assert root_vid["thumbnailStatus"] == "pending"

def test_api_files_endpoint(mock_media_folder):
    response = client.get("/api/files")
    assert response.status_code == 200
    data = response.json()
    
    assert "folders" in data
    assert "files" in data
    assert "/Sci-Fi" in data["folders"]
    assert "/root_video.mp4" in data["files"]

def test_api_resume_points_workflow(mock_media_folder):
    # 1. Post a resume progress point
    payload = {"path": "/Sci-Fi/sci_fi_movie.mp4", "time": 350}
    post_res = client.post("/api/resume", json=payload)
    assert post_res.status_code == 200
    assert post_res.json() == {"status": "ok"}
    
    # 2. Get resume database list
    get_res = client.get("/api/resume")
    assert get_res.status_code == 200
    db = get_res.json()
    assert db["/Sci-Fi/sci_fi_movie.mp4"] == 350
    
    # 3. Reset the state for the video
    reset_payload = {"path": "/Sci-Fi/sci_fi_movie.mp4"}
    reset_res = client.post("/api/resume/reset", json=reset_payload)
    assert reset_res.status_code == 200
    
    # Verify state is cleared
    get_res_cleared = client.get("/api/resume")
    assert "/Sci-Fi/sci_fi_movie.mp4" not in get_res_cleared.json()

def test_video_streaming_and_range_requests(mock_media_folder):
    # Test full video file download
    response_full = client.get("/videos/Sci-Fi/sci_fi_movie.mp4")
    assert response_full.status_code == 200
    assert response_full.headers["Content-Length"] == str(2 * 1024 * 1024)
    assert response_full.headers["Accept-Ranges"] == "bytes"
    
    # Test HTTP Range request query (e.g. bytes 0-999)
    headers = {"Range": "bytes=0-999"}
    response_range = client.get("/videos/Sci-Fi/sci_fi_movie.mp4", headers=headers)
    assert response_range.status_code == 206 # 206 Partial Content
    assert response_range.headers["Content-Length"] == "1000"
    assert response_range.headers["Content-Range"] == f"bytes 0-999/{2 * 1024 * 1024}"
    
    # Verify exact size of chunk payload received
    assert len(response_range.content) == 1000
