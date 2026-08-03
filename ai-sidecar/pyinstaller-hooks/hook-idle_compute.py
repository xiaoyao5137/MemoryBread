"""PyInstaller hook for idle_compute package"""
from PyInstaller.utils.hooks import collect_all
datas, binaries, hiddenimports = collect_all('idle_compute')
