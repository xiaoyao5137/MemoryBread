"""PyInstaller hook for monitor package"""
from PyInstaller.utils.hooks import collect_all
datas, binaries, hiddenimports = collect_all('monitor')
