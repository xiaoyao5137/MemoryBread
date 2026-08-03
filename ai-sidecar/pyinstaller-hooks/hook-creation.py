"""PyInstaller hook for creation package"""
from PyInstaller.utils.hooks import collect_all
datas, binaries, hiddenimports = collect_all('creation')
