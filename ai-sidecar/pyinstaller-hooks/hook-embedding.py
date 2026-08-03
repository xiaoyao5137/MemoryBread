"""PyInstaller hook for embedding package"""
from PyInstaller.utils.hooks import collect_all
datas, binaries, hiddenimports = collect_all('embedding')
