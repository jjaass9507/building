"""Waitress / HttpPlatformHandler 的進入點。

IIS 由 web.config 的 httpPlatform 啟動：

    waitress-serve.exe --port=%HTTP_PLATFORM_PORT% --threads=4 wsgi:application

本機要手動冒煙測試時：

    .\venv\Scripts\python.exe -m waitress --port=9099 wsgi:application
"""

from app import app as application

__all__ = ['application']
