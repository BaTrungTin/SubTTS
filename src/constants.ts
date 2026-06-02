export const VOICE_PROVIDERS = [
  { id: 'capcut', label: 'CapCut TTS (Miễn phí)' },
  { id: 'google', label: 'Google Cloud TTS' },
  { id: 'openai', label: 'OpenAI TTS' },
  { id: 'elevenlabs', label: 'ElevenLabs TTS' }
];

export const COUNTRIES = [
  { id: 'vn', label: 'Việt Nam' }
];

export const GENDERS = [
  { id: 'all', label: 'Tất cả giới tính' },
  { id: 'male', label: 'Nam' },
  { id: 'female', label: 'Nữ' }
];

export const DUBBING_MODES = [
  {
    id: 'video-priority',
    label: 'Chế độ 1: Ưu tiên video',
    description: 'Giữ nguyên thời lượng gốc của video. Nếu câu thoại nói dài hơn phụ đề, hệ thống tự động tăng tốc giọng đọc (atempo) để chèn vừa khớp.',
    bestFor: 'Tối ưu cho: Video ca nhạc, Tiktok ngắn, tin tức cần giữ thời lượng chuẩn.'
  },
  {
    id: 'hybrid',
    label: 'Chế độ 2: Hybrid (Tự động giãn video)',
    description: 'Phân tích thời lượng giọng đọc so với phụ đề, tự giãn khung hình khi câu tiếng Việt dài hơn slot gốc. Không bị chồng giọng line này lên line kia.',
    bestFor: 'Khuyên dùng: Phim Trung Quốc + phụ đề tiếng Việt, review phim, video nhiều hội thoại dài.'
  }
];

export const VOICE_DATA: Record<string, string[]> = {
  vn: [
    'Giọng nam phổ thông (Việt Nam)',
    'Giọng nữ ngọt ngào (Việt Nam)',
    'vi-VN-Standard-C',
    'vi-VN-Standard-D',
    'vi-VN-Wavenet-A',
    'vi-VN-Wavenet-C',
    'alloy',
    'echo',
    'fable',
    'onyx',
    'nova',
    'shimmer',
    '21m00Tcm4TlvDq8ikWAM', // Rachel ElevenLabs ID
    'AZnzlk1XvdvUeBnXmlld'  // Dom ElevenLabs ID
  ]
};
