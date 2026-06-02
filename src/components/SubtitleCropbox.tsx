import React, { useState, useEffect, useRef } from 'react';

interface CropBox {
  x: number; // percentage (0 - 100)
  y: number; // percentage (0 - 100)
  w: number; // percentage (0 - 100)
  h: number; // percentage (0 - 100)
}

interface SubtitleCropboxProps {
  onChange: (coords: { xMin: number; yMin: number; xMax: number; yMax: number }) => void;
}

export const SubtitleCropbox: React.FC<SubtitleCropboxProps> = ({ onChange }) => {
  // Default position: bottom 70-90% height, centered 10-90% width (perfect default for subtitles!)
  const [box, setBox] = useState<CropBox>({ x: 15, y: 75, w: 70, h: 15 });
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Dragging states
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState<string | null>(null); // 'tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'
  const dragStart = useRef({ x: 0, y: 0, boxX: 0, boxY: 0, boxW: 0, boxH: 0 });

  useEffect(() => {
    // Notify parent of initial box coordinates
    updateParent(box);
  }, []);

  const updateParent = (b: CropBox) => {
    onChange({
      xMin: b.x / 100,
      yMin: b.y / 100,
      xMax: (b.x + b.w) / 100,
      yMax: (b.y + b.h) / 100,
    });
  };

  const handleMouseDown = (e: React.MouseEvent, type: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (type === null) {
      setIsDragging(true);
    } else {
      setIsResizing(type);
    }

    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      boxX: box.x,
      boxY: box.y,
      boxW: box.w,
      boxH: box.h,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging && !isResizing) return;
      if (!containerRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const deltaX = ((e.clientX - dragStart.current.x) / rect.width) * 100;
      const deltaY = ((e.clientY - dragStart.current.y) / rect.height) * 100;

      let newBox = { ...box };

      if (isDragging) {
        // Move Box
        newBox.x = Math.max(0, Math.min(dragStart.current.boxX + deltaX, 100 - box.w));
        newBox.y = Math.max(0, Math.min(dragStart.current.boxY + deltaY, 100 - box.h));
      } else if (isResizing) {
        const type = isResizing;
        // Resize Box
        if (type.includes('r')) {
          newBox.w = Math.max(5, Math.min(dragStart.current.boxW + deltaX, 100 - dragStart.current.boxX));
        }
        if (type.includes('l')) {
          const maxW = dragStart.current.boxX + dragStart.current.boxW;
          newBox.x = Math.max(0, Math.min(dragStart.current.boxX + deltaX, maxW - 5));
          newBox.w = maxW - newBox.x;
        }
        if (type.includes('b')) {
          newBox.h = Math.max(5, Math.min(dragStart.current.boxH + deltaY, 100 - dragStart.current.boxY));
        }
        if (type.includes('t')) {
          const maxH = dragStart.current.boxY + dragStart.current.boxH;
          newBox.y = Math.max(0, Math.min(dragStart.current.boxY + deltaY, maxH - 5));
          newBox.h = maxH - newBox.y;
        }
      }

      setBox(newBox);
      updateParent(newBox);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(null);
    };

    if (isDragging || isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, box]);

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 z-20 pointer-events-none"
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: 'rgba(0,0,0,0.05)',
      }}
    >
      {/* Target Cropper Box */}
      <div
        className="absolute border-2 border-dashed border-cyan-400 bg-cyan-500/10 cursor-move group select-none shadow-[0_0_15px_rgba(34,211,238,0.3)] transition-colors hover:border-cyan-300 pointer-events-auto"
        style={{
          left: `${box.x}%`,
          top: `${box.y}%`,
          width: `${box.w}%`,
          height: `${box.h}%`,
        }}
        onMouseDown={(e) => handleMouseDown(e, null)}
      >
        {/* Visual Target Reticle */}
        <div className="absolute top-2 left-2 text-[10px] text-cyan-300 font-bold bg-black/60 px-1.5 py-0.5 rounded backdrop-blur">
          Subtitle Area ({box.w.toFixed(0)}% × {box.h.toFixed(0)}%)
        </div>

        {/* Drag Resizing Handles */}
        {/* Corners */}
        <div
          className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-cyan-400 border border-black rounded-full cursor-nwse-resize hover:bg-white transition-colors"
          onMouseDown={(e) => handleMouseDown(e, 'tl')}
        />
        <div
          className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-cyan-400 border border-black rounded-full cursor-nesw-resize hover:bg-white transition-colors"
          onMouseDown={(e) => handleMouseDown(e, 'tr')}
        />
        <div
          className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-cyan-400 border border-black rounded-full cursor-nesw-resize hover:bg-white transition-colors"
          onMouseDown={(e) => handleMouseDown(e, 'bl')}
        />
        <div
          className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-cyan-400 border border-black rounded-full cursor-nwse-resize hover:bg-white transition-colors"
          onMouseDown={(e) => handleMouseDown(e, 'br')}
        />

        {/* Sides */}
        <div
          className="absolute -top-1 left-1/2 -translate-x-1/2 w-8 h-1.5 bg-cyan-500/80 border border-black/50 rounded-sm cursor-ns-resize hover:bg-white"
          onMouseDown={(e) => handleMouseDown(e, 't')}
        />
        <div
          className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-8 h-1.5 bg-cyan-500/80 border border-black/50 rounded-sm cursor-ns-resize hover:bg-white"
          onMouseDown={(e) => handleMouseDown(e, 'b')}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -left-1 w-1.5 h-8 bg-cyan-500/80 border border-black/50 rounded-sm cursor-ew-resize hover:bg-white"
          onMouseDown={(e) => handleMouseDown(e, 'l')}
        />
        <div
          className="absolute top-1/2 -translate-y-1/2 -right-1 w-1.5 h-8 bg-cyan-500/80 border border-black/50 rounded-sm cursor-ew-resize hover:bg-white"
          onMouseDown={(e) => handleMouseDown(e, 'r')}
        />
      </div>
    </div>
  );
};
