"""
PyInstaller hook for rag package
确保所有 rag 子模块被正确收集
"""

from PyInstaller.utils.hooks import collect_all

# 收集 rag 包的所有内容：模块、数据文件、二进制文件等
datas, binaries, hiddenimports = collect_all('rag')
