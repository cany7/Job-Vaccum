"""PyInstaller entry; no dependency on the source checkout at runtime."""
from job_vaccum.__main__ import main

raise SystemExit(main())
