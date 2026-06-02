import React from 'react';

interface CheckboxProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

export const Checkbox: React.FC<CheckboxProps> = ({ label, checked, onChange, className }) => {
  return (
    <label className={`flex items-center gap-3 cursor-pointer select-none group text-xs text-gray-300 hover:text-white transition-colors ${className}`}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only"
      />
      <div className={`w-4 h-4 rounded border transition-all flex items-center justify-center ${
        checked
          ? 'bg-cyan-500 border-cyan-500 shadow-[0_0_8px_rgba(6,182,212,0.4)]'
          : 'bg-white/5 border-white/20 group-hover:border-white/40'
      }`}>
        {checked && (
          <svg className="w-2.5 h-2.5 text-black stroke-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      <span>{label}</span>
    </label>
  );
};
