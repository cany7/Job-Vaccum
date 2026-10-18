from pathlib import Path
from PyInstaller.utils.hooks import collect_all, copy_metadata

app_root = Path(SPECPATH).parent
datas = [(str(app_root / "backend/src/job_vaccum/storage/migrations"), "job_vaccum/storage/migrations")]
binaries = []
hiddenimports = []
for package in ("jobspy", "curl_cffi"):
    package_datas, package_binaries, package_imports = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_imports
datas += copy_metadata("python-jobspy")

a = Analysis([str(app_root / "packaging/backend_entry.py")],
             pathex=[str(app_root / "backend/src")], datas=datas,
             binaries=binaries, hiddenimports=hiddenimports)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True,
          name="job-vaccum-service", console=True, target_arch="arm64")
coll = COLLECT(exe, a.binaries, a.datas, name="job-vaccum-service")
