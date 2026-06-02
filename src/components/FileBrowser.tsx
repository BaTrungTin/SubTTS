import { useState, useEffect } from 'react';
import { Folder, Film, FileText, HardDrive, ArrowLeft, X } from 'lucide-react';

interface FileItem {
  name: string;
  path: string;
  type: 'folder' | 'video' | 'subtitle' | 'drive';
  size?: number;
}

interface FileBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (filePath: string) => void;
  title?: string;
  filterType?: 'video' | 'subtitle' | 'all';
}

import { apiUrl } from '../api/client';

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export default function FileBrowser({ isOpen, onClose, onSelect, title = 'Chọn Video', filterType = 'video' }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Load drives on first open
  useEffect(() => {
    if (isOpen && !currentPath) {
      loadDrives();
    }
  }, [isOpen]);

  const loadDrives = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/drives'));
      const data = await res.json();
      setItems(data);
      setCurrentPath('');
    } catch (e: any) {
      setError('Không thể kết nối server. Hãy chắc chắn server đang chạy.');
    } finally {
      setLoading(false);
    }
  };

  const loadDirectory = async (dirPath: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/list-dir?path=${encodeURIComponent(dirPath)}`));
      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'Lỗi đọc thư mục');
      }
      const data = await res.json();
      setItems(data);
      setCurrentPath(dirPath);
    } catch (e: any) {
      setError(e.message || 'Không thể đọc thư mục này');
    } finally {
      setLoading(false);
    }
  };

  const handleItemClick = (item: FileItem) => {
    if (item.type === 'drive' || item.type === 'folder') {
      loadDirectory(item.path || item.name);
    } else {
      onSelect(item.path);
      onClose();
    }
  };

  const goUp = () => {
    if (!currentPath) return;
    // Go to parent directory
    const parts = currentPath.replace(/[\\/]+$/, '').split(/[\\/]/);
    if (parts.length <= 1) {
      // Back to drive list
      loadDrives();
      setCurrentPath('');
    } else {
      parts.pop();
      let parentPath = parts.join('\\');
      if (parentPath.endsWith(':')) parentPath += '\\';
      loadDirectory(parentPath);
    }
  };

  const getIcon = (type: string) => {
    switch (type) {
      case 'drive': return <HardDrive className="w-5 h-5 text-cyan-400" />;
      case 'folder': return <Folder className="w-5 h-5 text-yellow-400" />;
      case 'video': return <Film className="w-5 h-5 text-green-400" />;
      case 'subtitle': return <FileText className="w-5 h-5 text-purple-400" />;
      default: return <FileText className="w-5 h-5 text-gray-400" />;
    }
  };

  if (!isOpen) return null;

  const displayItems = items.filter(item => {
    if (item.type === 'drive' || item.type === 'folder') return true;
    if (filterType === 'all') return true;
    return item.type === filterType;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[700px] max-h-[80vh] bg-[#12141a] border border-white/10 rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-white/[0.02]">
          <div className="flex items-center gap-3">
            <button
              onClick={goUp}
              disabled={!currentPath}
              className="p-1.5 rounded-lg hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition"
              title="Quay lại"
            >
              <ArrowLeft className="w-4 h-4 text-gray-300" />
            </button>
            <h3 className="text-sm font-bold text-white">{title}</h3>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/10 transition">
            <X className="w-4 h-4 text-gray-400" />
          </button>
        </div>

        {/* Path bar */}
        <div className="px-5 py-2 border-b border-white/5 bg-black/20">
          <p className="text-[11px] font-mono text-cyan-400/80 truncate">
            {currentPath || '💻 Ổ đĩa máy tính'}
          </p>
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto min-h-[300px]">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-sm text-gray-500 animate-pulse">Đang tải...</div>
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full px-8">
              <p className="text-sm text-red-400 text-center">{error}</p>
            </div>
          ) : displayItems.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-gray-600">Thư mục trống hoặc không có file phù hợp</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.03]">
              {displayItems.map((item, i) => (
                <button
                   key={i}
                  onClick={() => handleItemClick(item)}
                  className="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-white/[0.04] transition-colors group"
                >
                  {getIcon(item.type)}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-200 truncate group-hover:text-white transition">
                      {item.name}
                    </p>
                  </div>
                  {item.size !== undefined && item.size > 0 && (
                    <span className="text-[10px] text-gray-500 font-mono shrink-0">
                      {formatSize(item.size)}
                    </span>
                  )}
                  {(item.type === 'folder' || item.type === 'drive') && (
                    <span className="text-[10px] text-gray-600">›</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-2.5 border-t border-white/10 bg-white/[0.02] flex justify-between items-center">
          <span className="text-[10px] text-gray-600">
            {displayItems.filter(i => i.type === 'video' || i.type === 'subtitle').length} file · {displayItems.filter(i => i.type === 'folder').length} thư mục
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs text-gray-400 hover:text-white rounded-lg hover:bg-white/10 transition"
          >
            Hủy
          </button>
        </div>
      </div>
    </div>
  );
}
