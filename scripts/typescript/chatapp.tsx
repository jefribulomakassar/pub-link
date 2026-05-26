// =======
// FILE: components/ChatApp.tsx
// FIX: router.push diganti window.history.pushState — tidak ada flash/reload
// FITUR: Tombol stop, model di textarea, error di luar bubble, copy & audio
// FITUR: Profile user dari NextAuth OAuth (Google) + tombol logout
// FIX: Mobile — dropdown model dipindah ke LUAR container textarea (anti-lag)
// FIX: Suggestions menyesuaikan bahasa yang dipilih
// FITUR: Lanjutkan streaming jika respons terpotong (finish_reason: length)
// FITUR: Popup upgrade paket jika quota/token habis
// [DB] Integrasi Turso — obrolan disimpan ke DB, localStorage sebagai cache offline
// [BARU] Badge hijau "Dijawab dari internet" — muncul di atas bubble jika web search dipakai
// [FIX] Bahasa respons AI mengikuti bahasa input user (bukan bahasa UI)
// [FIX] Tombol delete sidebar pakai modal konfirmasi popup
// [FIX] Dropdown model hanya tampilkan model yang diaktifkan admin
// [UPDATE] Tema: 40 pilihan (28 dark + 12 light), mega menu desktop, grid mobile dengan scroll
// [FIX] history2 fix di continueResponse
// [FIX] Breadcrumb + trial banner digabung jadi satu baris (hemat space desktop)
// [FIX] DB-first load — localStorage hanya cache offline
// [FIX] Sync messages aktif ke conversations agar jumlah pesan selalu akurat
// [UPDATE] Brand config — import dari lib/brand.ts (single source of truth)
// [FIX] Sidebar: hapus section settings & clear all (terlalu teknis untuk user)
// [FIX] Mobile: bubble chat melebar full — ikon user & bot disembunyikan
// [FIX] Jumlah pesan di sidebar akurat saat pertama load (pakai activeMessages)
// [MOD] Chat column menyempit & terpusat (max-width 780px, bubble padding lebih compact)
// [MOD] Image generation dihapus — teks only
// [FITUR] Mobile swipe-up panel: tambah tombol Slide Generator (3 tombol total)
// =======

'use client'
import { useState, useRef, useEffect, useCallback, memo } from 'react'
import { useRouter } from 'next/navigation'
import { useSession, signOut } from 'next-auth/react'
import AppNavbar from '@/components/AppNavbar'
import SheetAnalyzer, { type SheetUIStrings } from '@/components/SheetAnalyzer'
import DataCanvasPanel, { type DataCanvas, type DCStrings } from '@/components/DataCanvasPanel'
import { BRAND } from '@/lib/brand'
import {
  Bot, User, Send, RotateCcw, Cloud, Zap, Check,
  Menu, X, Search, ChevronDown, Plus, Trash2,
  MessageSquare, Clock, Settings, Type, Globe,
  Copy, Volume2, VolumeX, StopCircle, LogOut,
  UserCircle, Loader2, ChevronRight,
  Sparkles, Crown, ArrowRight, Brain, Palette, FileSpreadsheet, Database, Share2, ExternalLink,
  Presentation, MapPin, FileImage, Camera, FolderOpen
} from 'lucide-react'
import { createPortal } from 'react-dom'
import WebScraperAgent from '@/components/WebScraperAgent'
import LocationAgent from '@/components/LocationAgent'
import FormBuilderAgent, {
  type FormSchema,
  type FormBuilderStrings,
} from '@/components/FormBuilderAgent'
import GoogleDriveAgent from '@/components/GoogleDriveAgent'

import {
  Conversation, ChatMessage,
  generateTitle,
  loadConversations, upsertConversation,
  deleteConversation, clearAllConversations,
  groupConversations, formatDate,
  saveConversations,
} from '@/lib/history'

// =======
// TYPES
// =======
interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

interface ErrorMessage {
  type: 'api' | 'network' | 'rate' | 'other' | 'quota'
  message: string
  originalError?: string
  timestamp: number
  canRetry: boolean
  isQuotaExceeded?: boolean
}

interface AudioState {
  isPlaying: boolean
  currentMessageId: string | null
}

interface TruncatedState {
  messageIndex: number
  convId: string
  partialContent: string
  continuationCount: number
}

// =======
// PASTED ARTIFACT
// =======
interface PastedArtifact {
  id: string
  content: string
  language: string   // 'code' | 'text'
  filename: string
  size: number       // char count
  timestamp: number
}

// =======
// IMAGE ATTACHMENT
// =======
interface ImageAttachment {
  id: string
  base64: string        // tanpa prefix data:...
  mimeType: string      // 'image/jpeg' | 'image/png' | 'image/webp'
  previewUrl: string    // untuk thumbnail (data URL lengkap)
  filename: string
}

function detectArtifactLanguage(text: string): string {
  const t = text.trim()
  if (!t) return 'text'

  // JSON
  if (/^[\[\{]/.test(t) && /[\]\}]$/.test(t)) {
    try { JSON.parse(t); return 'json' } catch {}
  }

  // HTML / XML
  if (/^<\?xml|^<!DOCTYPE|^<html/i.test(t)) return 'html'
  if (/<\/?[a-zA-Z][^>]*>/.test(t) && t.split('\n').length > 2) return 'html'
  // Multiline dengan indentasi atau kurung kurawal — kemungkinan besar kode
  const lines = t.split('\n')
  // TypeScript / JavaScript
  if (
    lines.length >= 5 &&
    (t.match(/[{}\[\]()]/g)?.length ?? 0) > 6 &&
    /^\s*(import |export |const |let |var |function |class |interface |type |async )/.test(t)
  ) return 'typescript'

  // Python
  if (/^\s*(def |class |import |from |@|#!\/usr\/bin\/python|print\(|if __name__)/.test(t)) return 'python'

  // SQL
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|EXPLAIN)\s/i.test(t)) return 'sql'

  // C / C++
  if (/^\s*(#include|int main|void |std::|cout|cin|printf|scanf)/.test(t)) return 'cpp'

  // Shell / Bash
  if (/^\s*(#!\/bin\/(bash|sh)|echo |cd |ls |grep |awk |sed |chmod |sudo |apt|npm |yarn |pip )/.test(t)) return 'code'

  // CSS
  if (/^\s*[\w.#*\[\]:@-]+\s*\{[\s\S]*?\}/.test(t) && t.includes(':') && t.includes(';')) return 'code'

  const hasIndent  = lines.filter(l => /^(\t|  {2,})/.test(l)).length > 2
  const hasBraces  = (t.match(/[{}\[\]()]/g)?.length ?? 0) > 4
  const isMultiline = lines.length > 4

  if (isMultiline && (hasIndent || hasBraces)) return 'code'

  return 'text'  // teks biasa → paste normal
}

function generateArtifactFilename(lang: string, index: number): string {
  const map: Record<string, string> = {
    json: `data-${index}.json`,
    html: `page-${index}.html`,
    typescript: `code-${index}.ts`,
    python: `script-${index}.py`,
    sql: `query-${index}.sql`,
    cpp: `program-${index}.cpp`,
    code: `snippet-${index}.txt`,
    text: `paste-${index}.txt`,
  }
  return map[lang] ?? `paste-${index}.txt`
}

function formatFileSize(chars: number): string {
  if (chars < 1000) return `${chars} chars`
  return `${(chars / 1000).toFixed(1)}k chars`
}

declare module '@/lib/history' {
  interface ChatMessage {
    isStopped?: boolean
    isTruncated?: boolean
    searchUsed?: boolean
    sources?: { title: string; url: string }[]
  }
}

// =======
// MODEL GROUP
// =======
type ModelGroupKey = 'flash' | 'smart' | 'deep' | 'elite'

// =======
// THEMES — 40 tema (28 dark + 12 light)
// =======
const THEMES = [
  { key:'original',  attr:null,        dot:'#f97316', label:'Original',     group:'dark'  },
  { key:'cobalt',    attr:'cobalt',    dot:'#3b82f6', label:'Deep Cobalt',  group:'dark'  },
  { key:'violet',    attr:'violet',    dot:'#a855f7', label:'Neon Violet',  group:'dark'  },
  { key:'teal',      attr:'teal',      dot:'#2dd4bf', label:'Arctic Teal',  group:'dark'  },
  { key:'matrix',    attr:'matrix',    dot:'#22c55e', label:'Matrix Green', group:'dark'  },
  { key:'softdark',  attr:'softdark',  dot:'#e8a045', label:'Soft Dark',    group:'dark'  },
  { key:'midnight',  attr:'midnight',  dot:'#6480f0', label:'Midnight',     group:'dark'  },
  { key:'amber',     attr:'amber',     dot:'#f5c400', label:'Amber',        group:'dark'  },
  { key:'slate',     attr:'slate',     dot:'#58a6ff', label:'Slate',        group:'dark'  },
  { key:'forest',    attr:'forest',    dot:'#6abf69', label:'Forest',       group:'dark'  },
  { key:'nord',      attr:'nord',      dot:'#88c0d0', label:'Nord',         group:'dark'  },
  { key:'dracula',   attr:'dracula',   dot:'#bd93f9', label:'Dracula',      group:'dark'  },
  { key:'mocha',     attr:'mocha',     dot:'#c8804a', label:'Mocha',        group:'dark'  },
  { key:'ocean',     attr:'ocean',     dot:'#00b4d8', label:'Ocean',        group:'dark'  },
  { key:'crimson',   attr:'crimson',   dot:'#e03050', label:'Crimson',      group:'dark'  },
  { key:'aurora',    attr:'aurora',    dot:'#40e0b0', label:'Aurora',       group:'dark'  },
  { key:'solarized', attr:'solarized', dot:'#2aa198', label:'Solarized',    group:'dark'  },
  { key:'candy',     attr:'candy',     dot:'#ff6eb4', label:'Candy',        group:'dark'  },
  { key:'neon',      attr:'neon',      dot:'#e040fb', label:'Neon',         group:'dark'  },
  { key:'desert',    attr:'desert',    dot:'#d4a043', label:'Desert',       group:'dark'  },
  { key:'obsidian',  attr:'obsidian',  dot:'#c0c0c0', label:'Obsidian',     group:'dark'  },
  { key:'sunset',    attr:'sunset',    dot:'#ff6a00', label:'Sunset',       group:'dark'  },
  { key:'steel',     attr:'steel',     dot:'#90a8c8', label:'Steel',        group:'dark'  },
  { key:'grape',     attr:'grape',     dot:'#9b59b6', label:'Grape',        group:'dark'  },
  { key:'retro',     attr:'retro',     dot:'#ff9900', label:'Retro',        group:'dark'  },
  { key:'espresso',  attr:'espresso',  dot:'#d4784a', label:'Espresso',     group:'dark'  },
  { key:'volcanic',  attr:'volcanic',  dot:'#e05a20', label:'Volcanic',     group:'dark'  },
  { key:'deepspace', attr:'deepspace', dot:'#7070e0', label:'Deep Space',   group:'dark'  },
  { key:'coral',    attr:'coral',    dot:'#2a9d8f', label:'Coral Reef',  group:'dark'  },
  { key:'carnival', attr:'carnival', dot:'#1982c4', label:'Carnival',    group:'dark'  },
  { key:'nordic',   attr:'nordic',   dot:'#00afb9', label:'Nordic',      group:'light' },
  { key:'chalk',     attr:'chalk',     dot:'#18181b', label:'Chalk',        group:'light' },
  { key:'cupertino', attr:'cupertino', dot:'#007aff', label:'Cupertino',    group:'light' },
  { key:'silver',    attr:'silver',    dot:'#5b5ea6', label:'Silver',       group:'light' },
  { key:'rose',      attr:'rose',      dot:'#e8305a', label:'Rose',         group:'light' },
  { key:'sakura',    attr:'sakura',    dot:'#d4648a', label:'Sakura',       group:'light' },
  { key:'latte',     attr:'latte',     dot:'#8b5e3c', label:'Latte',        group:'light' },
  { key:'paper',     attr:'paper',     dot:'#2d6a4f', label:'Paper',        group:'light' },
  { key:'mint',      attr:'mint',      dot:'#059669', label:'Mint',         group:'light' },
  { key:'lavender',  attr:'lavender',  dot:'#7c3aed', label:'Lavender',     group:'light' },
  { key:'sky',       attr:'sky',       dot:'#0284c7', label:'Sky',          group:'light' },
  { key:'glacier',   attr:'glacier',   dot:'#4a90d9', label:'Glacier',      group:'light' },
  { key:'peach',     attr:'peach',     dot:'#e8721e', label:'Peach',        group:'light' },
] as const

const LIGHT_THEMES = new Set([
  'chalk','cupertino','silver','rose','sakura',
'latte','paper','mint','lavender','sky','glacier','peach','nordic',
])

const FONTS = [
  { key: 'dm-mono',   label: 'DM Mono',         family: "'DM Mono', monospace",        tag: 'Mono'    },
  { key: 'inter',     label: 'Inter',            family: "'Inter', sans-serif",         tag: 'Sans'    },
  { key: 'syne',      label: 'Syne',             family: "'Syne', sans-serif",          tag: 'Display' },
  { key: 'jetbrains', label: 'JetBrains Mono',   family: "'JetBrains Mono', monospace", tag: 'Mono'    },
  { key: 'fira',      label: 'Fira Code',        family: "'Fira Code', monospace",      tag: 'Mono'    },
  { key: 'roboto',    label: 'Roboto',           family: "'Roboto', sans-serif",        tag: 'Sans'    },
  { key: 'nunito',    label: 'Nunito',           family: "'Nunito', sans-serif",        tag: 'Rounded' },
  { key: 'lora',      label: 'Lora',             family: "'Lora', serif",               tag: 'Serif'   },
  { key: 'playfair',  label: 'Playfair Display', family: "'Playfair Display', serif",   tag: 'Serif'   },
  { key:'space',      label:'Space Grotesk',    family:"'Space Grotesk', sans-serif",    tag:'Modern'   },
  { key:'outfit',     label:'Outfit',           family:"'Outfit', sans-serif",           tag:'Clean'    },
  { key:'jakarta', label:'Plus Jakarta Sans', family:"'Plus Jakarta Sans', sans-serif", tag:'Modern' },
  { key:'dmsans',  label:'DM Sans',           family:"'DM Sans', sans-serif",           tag:'Clean'  },
  { key:'geist',      label:'Geist Mono',       family:"'Geist Mono', monospace",        tag:'Mono'     },
  { key:'sourceserif',label:'Source Serif 4',   family:"'Source Serif 4', serif",        tag:'Serif'    },
  { key:'fraunces',   label:'Fraunces',         family:"'Fraunces', serif",              tag:'Optical'  },
  { key:'epilogue',   label:'Epilogue',         family:"'Epilogue', sans-serif",         tag:'Sans'     },
  { key:'chivo',      label:'Chivo Mono',       family:"'Chivo Mono', monospace",        tag:'Mono'     },
] as const

const FONT_URLS: Record<string, string> = {
  inter:     'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
  jetbrains: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap',
  fira:      'https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500&display=swap',
  roboto:    'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500&display=swap',
  nunito:    'https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700&display=swap',
  lora:      'https://fonts.googleapis.com/css2?family=Lora:wght@400;500;600&display=swap',
  playfair:  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&display=swap',
  space:       'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&display=swap',
  outfit:      'https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600&display=swap',
  geist:       'https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap',
  sourceserif: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:wght@400;500;600&display=swap',
  fraunces:    'https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;0,600;1,400&display=swap',
  epilogue:    'https://fonts.googleapis.com/css2?family=Epilogue:wght@400;500;600&display=swap',
  chivo:       'https://fonts.googleapis.com/css2?family=Chivo+Mono:wght@400;500&display=swap',
  jakarta: 'https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600&display=swap',
  dmsans:  'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap',
}

type LangKey = 'id' | 'en' | 'ar' | 'zh' | 'ja' | 'ko' | 'es' | 'fr'

interface UIStrings {
  newChat: string; searchPlaceholder: string; noConversations: string; noResults: string
  suggestions: string[]
  model: string; systemPrompt: string; systemPromptPh: string; clearAll: string
  deleteConfirm: string; today: string; yesterday: string; days7: string
  thisMonth: string; older: string; messages: string; savedAuto: string
  typeMessage: string; enterSend: string; shiftNewline: string; webSearch: string
  admin: string; theme: string; font: string; language: string; settings: string
  startChat: string; orSelectOld: string; prompt: string; completion: string; total: string
  copy: string; copied: string; listen: string; stop: string; retry: string
  share: string; shareSource: string
  errorApi: string; errorNetwork: string; errorRate: string; errorOther: string
  dismiss: string; errorTitle: string; profile: string; logout: string; myAccount: string
  generatingImage: string; imagePromptLabel: string; downloadImage: string; imageError: string
  viewFull: string; clickToZoom: string
  continueBtnLabel: string; continuingLabel: string; truncatedNotice: string
  upgradeTitle: string; upgradeDesc: string; upgradeBtn: string; upgradeDismiss: string
  quotaExceeded: string
  aiDisclaimer: string
  deleteTitle: string; deleteDesc: string; deleteConfirmBtn: string; deleteCancelBtn: string
  trialExpiredClose: string
  trialExpiredViewHistory: string
  trialComingSoonTitle:   string
  trialComingSoonSub:     string
  trialComingSoonItem1:   string
  trialComingSoonItem2:   string
  trialComingSoonItem3:   string
  trialComingSoonCta:     string
  trialComingSoonFooter:  string
  groupPickerTitle: string
  groupFlashLabel: string; groupFlashDesc: string
  groupSmartLabel: string; groupSmartDesc: string
  groupDeepLabel: string;  groupDeepDesc: string
  groupEliteLabel: string; groupEliteDesc: string
  viewProfile: string
  upgradePacketLabel: string
  upgradePacketDesc:  string
  trialBadgeExpired:    string
  trialBadgePct:        string
  trialBannerText:      string
  trialQuotaTitle:      string
  trialQuotaSub:        string
  trialQuotaItem1:      string
  trialQuotaItem2:      string
  trialQuotaCta:        string
  convFallbackTitle:  string
  trialExpiredErrMsg: string
  continuationInstr:  string
  sheetTitle:         string
  sheetBaris:         string
  sheetKolom:         string
  sheetUploadTab:     string
  sheetLinkTab:       string
  sheetClickDrop:     string
  sheetFormats:       string
  sheetSharingNote:   string
  sheetSharingLink:   string
  sheetLoadingFile:   string
  sheetLoadingSheets: string
  sheetErrorRead:     string
  sheetErrorSheets:   string
  sheetErrorAnalyze:  string
  sheetRawToggleHide: string
  sheetRawToggleShow: string
  sheetRawLabel:      string
  sheetKuotaLabel:    string
  sheetAiLabel:       string
  sheetRegenerate:    string
  sheetAnalyzing:     string
  sheetAskPlaceholder:string
  sheetChangeFile:    string
  sheetTrendTitle:    string
  sheetExportExcel:   string
  sheetExportPdf:     string
  sheetErrorSheets401: string
  sheetErrorSheets403: string
  sheetErrorSheets404: string
  sheetErrorSheetsNet: string
  sheetErrorReadSize:  string
  sheetErrorReadFormat: string
  dcTitle:        string; dcLembar:    string; dcBaris:     string; dcKolom:   string
  dcAktif:        string; dcChat:      string; dcAktifTitle:string; dcPakaiTitle:string
  dcLagi:         string; dcBukaSheets:string; dcLoading:   string; dcRefresh: string
  dcGagal:        string; dcKosong:    string; dcKosongSub: string; dcTersimpan:string
  dcBaruSaja:     string; dcMntLalu:   string; dcJamLalu:   string; dcHariLalu: string
  // [BRAND] Label preferensi pengguna di sidebar
  userPreferences: string
  scraperTitle:        string
  scraperSubtitle:     string
  scraperUrlLabel:     string
  scraperUrlPh:        string
  scraperUrlError:     string
  scraperModeLabel:    string
  scraperModeSum:      string; scraperModeSumDesc: string
  scraperModeExt:      string; scraperModeExtDesc: string
  scraperModeAna:      string; scraperModeAnaDesc: string
  scraperModeQa:       string; scraperModeQaDesc:  string
  scraperQaLabel:      string; scraperQaPh:        string
  scraperBtnRun:       string; scraperBtnCancel:   string
  scraperErrTitle:     string; scraperErrTips:     string
  scraperStepsDone:    string; scraperProcessing:  string
  scraperResultLabel:  string
  scraperSendChat:     string; scraperCopy:        string
  scraperCopied:       string; scraperRetry:       string
  scraperAiAnalyzing:  string; scraperCancelled:   string
  scraperWordCount:    string; scraperLinkCount:   string; scraperImgCount: string
  fbTitle:           string
  fbSubtitle:        string
  fbModeInterview:   string
  fbModeManual:      string
  fbModeTemplate:    string
  fbStartInterview:  string
  fbGenerating:      string
  fbPreview:         string
  fbEdit:            string
  fbEmbed:           string
  fbShare:           string
  fbCopy:            string
  fbCopied:          string
  fbSave:            string
  fbSaved:           string
  fbSaving:          string
  fbAddField:        string
  fbAddSection:      string
  fbDeleteField:     string
  fbDeleteSection:   string
  fbRequired:        string
  fbFieldLabel:      string
  fbFieldType:       string
  fbFieldPlaceholder:string
  fbFieldHint:       string
  fbOptions:         string
  fbAddOption:       string
  fbSectionTitle:    string
  fbSectionDesc:     string
  fbMinEntries:      string
  fbMaxEntries:      string
  fbSubmitLabel:     string
  fbSuccessMsg:      string
  fbFormTitle:       string
  fbFormDesc:        string
  fbStaticFields:    string
  fbDynSections:     string
  fbSendToChat:      string
  fbNewForm:         string
  fbEmbedCode:       string
  fbShareLink:       string
  fbInterviewStep:   string
  fbInterviewOf:     string
  fbSkip:            string
  fbTemplates:       string
}

const LANGUAGES: Record<LangKey, { label: string; flag: string; ui: UIStrings }> = {
  id: { label: 'Indonesia', flag: '🇮🇩', ui: {
    newChat:'Obrolan Baru', searchPlaceholder:'Cari percakapan...', noConversations:'Belum ada percakapan.\nMulai obrolan baru!', noResults:'Tidak ditemukan',
    suggestions: [
      '🏥|Kesehatan|Saya ingin konsultasi tentang kesehatan dan gaya hidup sehat',
      '💰|Keuangan|Bantu saya merencanakan keuangan pribadi dan investasi',
      '📚|Pendidikan|Saya ingin belajar dan memahami topik akademis lebih dalam',
      '🌿|Lingkungan|Diskusikan isu lingkungan dan cara hidup ramah lingkungan',
      '📔|Jurnal Harian|Bantu saya menulis jurnal refleksi dan pengembangan diri',
      '💼|Karier|Konsultasi karier, CV, dan pengembangan profesional',
      '🍳|Memasak|Rekomendasi resep dan tips memasak sehari-hari',
      '🧠|Psikologi|Diskusi kesehatan mental dan pengembangan diri',
      ],
    model:'Model', systemPrompt:'System Prompt', systemPromptPh:'Atur perilaku asisten...', clearAll:'Hapus Semua',
    deleteConfirm:'Klik lagi untuk konfirmasi', today:'Hari Ini', yesterday:'Kemarin', days7:'7 Hari Lalu',
    thisMonth:'Bulan Ini', older:'Lebih Lama', messages:'pesan', savedAuto:'Tersimpan otomatis',
    typeMessage:'Tulis pesan...', enterSend:'Enter kirim', shiftNewline:'Shift+Enter baris baru',
    webSearch:'Dijawab dari internet', admin:'Admin', theme:'Tema', font:'Font', language:'Bahasa',
    settings:'Pengaturan', startChat:'Ketik pesan untuk memulai percakapan.',
    orSelectOld:'Pilih percakapan lama di sidebar\natau mulai obrolan yang lebih spesifik.',
    prompt:'Prompt', completion:'Completion', total:'Total',
    copy:'Salin', copied:'Tersalin!', listen:'Dengarkan', stop:'Berhenti', retry:'Coba Lagi', share:'Bagikan', shareSource:'Sumber',
    errorApi:'Gangguan pada layanan AI', errorNetwork:'Koneksi terputus', errorRate:'Terlalu banyak permintaan', errorOther:'Gangguan sementara',
    dismiss:'Tutup', errorTitle:'Terjadi Kesalahan', profile:'Profil', logout:'Keluar', myAccount:'Akun Saya',
    generatingImage:'Membuat gambar...', imagePromptLabel:'Prompt:', downloadImage:'⬇ Download', imageError:'Gagal membuat gambar. Coba lagi.',
    viewFull:'🔍 Lihat Penuh', clickToZoom:'🔍 Klik untuk perbesar',
    continueBtnLabel:'Lanjutkan Respons', continuingLabel:'Melanjutkan...', truncatedNotice:'Respons terpotong — klik untuk melanjutkan',
    upgradeTitle:'Kuota Habis', upgradeDesc:'Token bulanan Anda telah habis. Upgrade paket untuk melanjutkan percakapan tanpa batas.', upgradeBtn:'Upgrade Sekarang', upgradeDismiss:'Nanti Saja',
    quotaExceeded:'Kuota token Anda telah habis.',
    aiDisclaimer: 'AI dapat membuat kesalahan. Periksa informasi penting.',
    deleteTitle:'Hapus Obrolan?', deleteDesc:'akan dihapus dari daftar riwayat obrolan.', deleteConfirmBtn:'Hapus', deleteCancelBtn:'Batal',
    trialExpiredClose: 'Tutup',
    trialExpiredViewHistory: 'Lihat history obrolan saja',trialComingSoonTitle:  '🚧 Segera Hadir',
    trialComingSoonSub:    'Sistem pembayaran sedang dalam tahap pengembangan akhir. Kami sedang menyiapkan pengalaman berlangganan yang aman dan mudah untukmu.',
    trialComingSoonItem1:  'Integrasi payment gateway sedang diuji coba',
    trialComingSoonItem2:  'Keamanan transaksi dalam proses sertifikasi',
    trialComingSoonItem3:  'Kamu akan diberitahu via email saat sudah tersedia',
    trialComingSoonCta:    'Mengerti, Beritahu Saya Nanti',
    trialComingSoonFooter: 'Kamu tetap bisa membaca semua riwayat obrolan sebelumnya.',
    groupPickerTitle: 'Pilih Kecerdasan AI',
    groupFlashLabel: 'Swift 3.1',  groupFlashDesc: 'Respons instan & ringan',
    groupSmartLabel: 'Pro 4.2',    groupSmartDesc: 'Seimbang & andal',
    groupDeepLabel:  'Ultra 4.8',  groupDeepDesc:  'Analisis mendalam',
    groupEliteLabel: 'Max 5.0',    groupEliteDesc: 'Kemampuan terbaik',
    viewProfile: 'Lihat Profil',
    sheetTitle:         'Analisis Data',
    sheetBaris:         'baris',
    sheetKolom:         'kolom',
    sheetUploadTab:     '📂 Upload Excel / CSV',
    sheetLinkTab:       '🔗 Google Sheets Link',
    sheetClickDrop:     'Klik atau drag & drop file',
    sheetFormats:       '.xlsx · .xls · .csv · maks 10MB',
    sheetSharingNote:   'Pastikan sharing Google Sheets diset ke',
    sheetSharingLink:   'Anyone with the link can view',
    sheetLoadingFile:   'Membaca file…',
    sheetLoadingSheets: 'Mengambil data Google Sheets…',
    sheetErrorRead:     'Gagal membaca file',
    sheetErrorSheets:   'Gagal mengambil Google Sheets',
    sheetErrorAnalyze:  'Gagal menganalisis data',
    sheetRawToggleHide: 'Sembunyikan',
    sheetRawToggleShow: 'Lihat',
    sheetRawLabel:      'data mentah (sample {n} baris)',
    sheetKuotaLabel:    'Kuota terpakai',
    sheetAiLabel:       '🤖 AI Insights',
    sheetRegenerate:    'Regenerate',
    sheetAnalyzing:     'Menganalisis data…',
    sheetAskPlaceholder:'Tanya sesuatu, misal: Siapa top 5? atau Bulan mana paling tinggi?',
    sheetChangeFile:    'Analisis file lain',
    sheetTrendTitle:    'Tren Data',
    sheetExportExcel:   'Excel',
    sheetExportPdf: 'PDF',
    dcTitle:'Data Canvas', dcLembar:'lembar', dcBaris:'baris', dcKolom:'kolom', dcAktif:'Aktif', dcChat:'Chat', dcAktifTitle:'Sudah aktif di chat', dcPakaiTitle:'Pakai di obrolan', dcLagi:'+{n} lagi', dcBukaSheets:'Buka Google Sheets', dcLoading:'Memuat…', dcRefresh:'Refresh', dcGagal:'Gagal memuat', dcKosong:'Belum ada Data Canvas.', dcKosongSub:'Upload Excel atau Google Sheets untuk membuat lembar analisis pertama.', dcTersimpan:'✓ Tersimpan', dcBaruSaja:'baru saja', dcMntLalu:'{n} mnt lalu', dcJamLalu:'{n} jam lalu', dcHariLalu:'{n} hari lalu',
    upgradePacketLabel: 'Upgrade Paket',
    upgradePacketDesc:  'Akses tanpa batas & lebih cepat',
    trialBadgeExpired:    '⚠ Kuota habis · Upgrade',
    trialBadgePct:        '{pct}% tersisa',
    trialBannerText:      '{pct}% kuota tersisa — upgrade untuk akses tanpa batas.',
    trialQuotaTitle:      '📊 Status Kuota Kamu',
    trialQuotaSub:        '{pct}% kuota masih tersisa. Gunakan dengan bijak!',
    trialQuotaItem1:      '💬 Kamu masih bisa mengirim pesan dan bertanya.',
    trialQuotaItem2:      '⚡ Upgrade untuk kuota unlimited tanpa batas.',
    trialQuotaCta:        'Oke, Mengerti',
    convFallbackTitle:  'Percakapan',
    trialExpiredErrMsg: 'Masa uji coba gratis telah berakhir. Silakan upgrade.',
    continuationInstr:  '[SISTEM: Respons terpotong. Lanjutkan dari: "...{snippet}"] Lanjutkan respons Anda.',
    userPreferences: 'Preferensi Pengguna',
    scraperTitle:'Agen Pengikis Web', scraperSubtitle:'Baca & analisis konten website apapun',
    scraperUrlLabel:'URL Website', scraperUrlPh:'https://example.com/artikel-atau-halaman',
    scraperUrlError:'URL harus dimulai dengan https:// atau http://',
    scraperModeLabel:'Mode Analisis',
    scraperModeSum:'Rangkum', scraperModeSumDesc:'Ringkasan komprehensif',
    scraperModeExt:'Ekstrak', scraperModeExtDesc:'Data terstruktur',
    scraperModeAna:'Analisis', scraperModeAnaDesc:'Analisis mendalam',
    scraperModeQa:'Tanya', scraperModeQaDesc:'Tanya jawab',
    scraperQaLabel:'Pertanyaan Anda', scraperQaPh:'Apa yang ingin Anda ketahui dari website ini?',
    scraperBtnRun:'Kikis & Analisis', scraperBtnCancel:'Batalkan',
    scraperErrTitle:'Gagal mengambil konten', scraperErrTips:'Pastikan URL dapat diakses publik dan bukan halaman yang butuh login.',
    scraperStepsDone:'{n} langkah selesai', scraperProcessing:'Memproses...',
    scraperResultLabel:'Hasil Analisis',
    scraperSendChat:'Kirim ke Chat', scraperCopy:'Salin', scraperCopied:'Tersalin!',
    scraperRetry:'Ulang', scraperAiAnalyzing:'AI sedang menganalisis...',
    scraperCancelled:'⏹ Dibatalkan',
    scraperWordCount:'{n} kata', scraperLinkCount:'{n} link', scraperImgCount:'{n} gambar',
    sheetErrorSheets401:'Google Sheets tidak bisa diakses (401). Buka Google Sheets → Share → ubah ke "Anyone with the link can view".',
    sheetErrorSheets403:'Akses ditolak (403). Pastikan sharing Google Sheets diset ke "Anyone with the link" bukan "Restricted".',
    sheetErrorSheets404:'Spreadsheet tidak ditemukan (404). Periksa apakah link benar dan file masih ada.',
    sheetErrorSheetsNet:'Gagal terhubung ke Google Sheets. Periksa koneksi internet Anda dan coba lagi.',
    sheetErrorReadSize:'File terlalu besar. Maksimal 10MB. Coba hapus sheet yang tidak perlu atau kompres datanya.',
    sheetErrorReadFormat:'Format file tidak didukung. Gunakan .xlsx, .xls, atau .csv.',
    fbTitle:           'Form Builder AI',
    fbSubtitle:        'Buat form dinamis dengan AI Interview atau manual',
    fbModeInterview:   'AI Interview',
    fbModeManual:      'Manual',
    fbModeTemplate:    'Template',
    fbStartInterview:  'Mulai Interview',
    fbGenerating:      'AI sedang membuat form...',
    fbPreview:         'Preview',
    fbEdit:            'Edit',
    fbEmbed:           'Embed',
    fbShare:           'Bagikan',
    fbCopy:            'Salin',
    fbCopied:          'Tersalin!',
    fbSave:            'Simpan Form',
    fbSaved:           'Tersimpan',
    fbSaving:          'Menyimpan...',
    fbAddField:        '+ Tambah Kolom',
    fbAddSection:      '+ Tambah Section',
    fbDeleteField:     'Hapus kolom',
    fbDeleteSection:   'Hapus section',
    fbRequired:        'Wajib diisi',
    fbFieldLabel:      'Label kolom',
    fbFieldType:       'Tipe',
    fbFieldPlaceholder:'Placeholder',
    fbFieldHint:       'Petunjuk (opsional)',
    fbOptions:         'Opsi jawaban',
    fbAddOption:       'Tambah opsi',
    fbSectionTitle:    'Judul section',
    fbSectionDesc:     'Deskripsi',
    fbMinEntries:      'Min entri',
    fbMaxEntries:      'Maks entri',
    fbSubmitLabel:     'Teks tombol kirim',
    fbSuccessMsg:      'Pesan sukses',
    fbFormTitle:       'Judul form',
    fbFormDesc:        'Deskripsi form',
    fbStaticFields:    'Kolom Utama',
    fbDynSections:     'Section Dinamis',
    fbSendToChat:      'Kirim ke Chat',
    fbNewForm:         'Buat Form Baru',
    fbEmbedCode:       'Kode Embed',
    fbShareLink:       'Link Berbagi',
    fbInterviewStep:   'Pertanyaan',
    fbInterviewOf:     'dari',
    fbSkip:            'Lewati',
    fbTemplates:       'Pilih Template',
  }},
  en: { label: 'English', flag: '🇬🇧', ui: {
    newChat:'New Chat', searchPlaceholder:'Search conversations...', noConversations:'No conversations yet.\nStart a new chat!', noResults:'Not found',
    suggestions: [
      '🏥|Health|I want to discuss health topics and healthy lifestyle habits',
      '💰|Finance|Help me plan personal finances and investments',
      '📚|Education|I want to learn and understand academic topics in depth',
      '🌿|Environment|Discuss environmental issues and eco-friendly living',
      '📔|Journal|Help me write a reflective journal and personal growth log',
      '💼|Career|Career consultation, resume tips, and professional development',
      '🍳|Cooking|Recipe recommendations and everyday cooking tips',
      '🧠|Psychology|Discuss mental health and personal development',
      ],
    model:'Model', systemPrompt:'System Prompt', systemPromptPh:'Set assistant behavior...', clearAll:'Clear All',
    deleteConfirm:'Click again to confirm', today:'Today', yesterday:'Yesterday', days7:'Last 7 Days',
    thisMonth:'This Month', older:'Older', messages:'messages', savedAuto:'Auto-saved',
    typeMessage:'Type a message...', enterSend:'Enter to send', shiftNewline:'Shift+Enter new line',
    webSearch:'Answered from the web', admin:'Admin', theme:'Theme', font:'Font', language:'Language',
    settings:'Settings', startChat:'Type a message to start chatting.',
    orSelectOld:'Select an old conversation\nor start a more specific conversation.',
    prompt:'Prompt', completion:'Completion', total:'Total',
    copy:'Copy', copied:'Copied!', listen:'Listen', stop:'Stop', retry:'Retry', share:'Share', shareSource:'Source',
    errorApi:'AI service unavailable', errorNetwork:'Connection lost', errorRate:'Too many requests', errorOther:'Temporary issue',
    dismiss:'Dismiss', errorTitle:'Error Occurred', profile:'Profile', logout:'Logout', myAccount:'My Account',
    generatingImage:'Generating image...', imagePromptLabel:'Prompt:', downloadImage:'⬇ Download', imageError:'Failed to generate image. Try again.',
    viewFull:'🔍 View Full', clickToZoom:'🔍 Click to zoom',
    continueBtnLabel:'Continue Response', continuingLabel:'Continuing...', truncatedNotice:'Response cut off — click to continue',
    upgradeTitle:'Quota Exceeded', upgradeDesc:'Your monthly token quota has been reached. Upgrade your plan to continue chatting without limits.', upgradeBtn:'Upgrade Now', upgradeDismiss:'Maybe Later',
    quotaExceeded:'Your token quota has been exceeded.',
    aiDisclaimer: 'AI can make mistakes. Verify important information.',
    deleteTitle:'Delete Chat?', deleteDesc:'will be removed from your chat history.', deleteConfirmBtn:'Delete', deleteCancelBtn:'Cancel',
    trialExpiredClose: 'Close',
    trialExpiredViewHistory: 'Just view chat history',
    trialComingSoonTitle:  '🚧 Coming Soon',
    trialComingSoonSub:    'Our payment system is in final development. We\'re preparing a safe and seamless subscription experience for you.',
    trialComingSoonItem1:  'Payment gateway integration under testing',
    trialComingSoonItem2:  'Transaction security in certification process',
    trialComingSoonItem3:  'You\'ll be notified via email when it\'s ready',
    trialComingSoonCta:    'Got it, Notify Me Later',
    trialComingSoonFooter: 'You can still read all your previous chat history.',
    groupPickerTitle: 'Choose AI Intelligence',
    groupFlashLabel: 'Swift 3.1',  groupFlashDesc: 'Instant response & lightweight',
    groupSmartLabel: 'Pro 4.2',    groupSmartDesc: 'Balanced & reliable',
    groupDeepLabel:  'Ultra 4.8',  groupDeepDesc:  'Deep analysis',
    groupEliteLabel: 'Max 5.0',    groupEliteDesc: 'Best capability',
    viewProfile: 'View Profile',
    sheetTitle:         'Data Analysis',
    sheetBaris:         'rows',
    sheetKolom:         'columns',
    sheetUploadTab:     '📂 Upload Excel / CSV',
    sheetLinkTab:       '🔗 Google Sheets Link',
    sheetClickDrop:     'Click or drag & drop file',
    sheetFormats:       '.xlsx · .xls · .csv · max 10MB',
    sheetSharingNote:   'Make sure Google Sheets sharing is set to',
    sheetSharingLink:   'Anyone with the link can view',
    sheetLoadingFile:   'Reading file…',
    sheetLoadingSheets: 'Fetching Google Sheets…',
    sheetErrorRead:     'Failed to read file',
    sheetErrorSheets:   'Failed to fetch Google Sheets',
    sheetErrorAnalyze:  'Failed to analyze data',
    sheetRawToggleHide: 'Hide',
    sheetRawToggleShow: 'View',
    sheetRawLabel:      'raw data (sample {n} rows)',
    sheetKuotaLabel:    'Quota used',
    sheetAiLabel:       '🤖 AI Insights',
    sheetRegenerate:    'Regenerate',
    sheetAnalyzing:     'Analyzing data…',
    sheetAskPlaceholder:'Ask something, e.g. Who are top 5? or Which month is highest?',
    sheetChangeFile:    'Analyze another file',
    sheetTrendTitle:    'Data Trend',
    sheetExportExcel:   'Excel',
    sheetExportPdf: 'PDF',
    dcTitle:'Data Canvas', dcLembar:'sheets', dcBaris:'rows', dcKolom:'columns', dcAktif:'Active', dcChat:'Chat', dcAktifTitle:'Already active in chat', dcPakaiTitle:'Use in chat', dcLagi:'+{n} more', dcBukaSheets:'Open Google Sheets', dcLoading:'Loading…', dcRefresh:'Refresh', dcGagal:'Failed to load', dcKosong:'No Data Canvas yet.', dcKosongSub:'Upload Excel or Google Sheets to create your first analysis sheet.', dcTersimpan:'✓ Saved', dcBaruSaja:'just now', dcMntLalu:'{n} min ago', dcJamLalu:'{n} hr ago', dcHariLalu:'{n} days ago',
    upgradePacketLabel: 'Upgrade Plan',
    upgradePacketDesc:  'Unlimited access & faster responses',
    trialBadgeExpired:    '⚠ Quota exceeded · Upgrade',
    trialBadgePct:        '{pct}% remaining',
    trialBannerText:      '{pct}% quota remaining — upgrade for unlimited access.',
    trialQuotaTitle:      '📊 Your Quota Status',
    trialQuotaSub:        '{pct}% of your quota is still available. Use it wisely!',
    trialQuotaItem1:      '💬 You can still send messages and ask questions.',
    trialQuotaItem2:      '⚡ Upgrade for unlimited quota with no limits.',
    trialQuotaCta:        'Got it',
    convFallbackTitle:  'Conversation',
    trialExpiredErrMsg: 'Your free trial has ended. Please upgrade.',
    continuationInstr:  '[SYSTEM: Response was cut off. Continue from: "...{snippet}"] Continue your response.',
    userPreferences: 'User Preferences',
    scraperTitle:'Web Scraper Agent', scraperSubtitle:'Read & analyze any website content',
    scraperUrlLabel:'Website URL', scraperUrlPh:'https://example.com/article-or-page',
    scraperUrlError:'URL must start with https:// or http://',
    scraperModeLabel:'Analysis Mode',
    scraperModeSum:'Summarize', scraperModeSumDesc:'Comprehensive summary',
    scraperModeExt:'Extract', scraperModeExtDesc:'Structured data',
    scraperModeAna:'Analyze', scraperModeAnaDesc:'Deep analysis',
    scraperModeQa:'Ask', scraperModeQaDesc:'Q&A',
    scraperQaLabel:'Your Question', scraperQaPh:'What do you want to know from this website?',
    scraperBtnRun:'Scrape & Analyze', scraperBtnCancel:'Cancel',
    scraperErrTitle:'Failed to fetch content', scraperErrTips:'Make sure the URL is publicly accessible and does not require login.',
    scraperStepsDone:'{n} steps completed', scraperProcessing:'Processing...',
    scraperResultLabel:'Analysis Result',
    scraperSendChat:'Send to Chat', scraperCopy:'Copy', scraperCopied:'Copied!',
    scraperRetry:'Retry', scraperAiAnalyzing:'AI is analyzing...',
    scraperCancelled:'⏹ Cancelled',
    scraperWordCount:'{n} words', scraperLinkCount:'{n} links', scraperImgCount:'{n} images',
    sheetErrorSheets401:'Google Sheets is not accessible (401). Open Google Sheets → Share → set to "Anyone with the link can view".',
    sheetErrorSheets403:'Access denied (403). Make sure sharing is set to "Anyone with the link", not "Restricted".',
    sheetErrorSheets404:'Spreadsheet not found (404). Check if the link is correct and the file still exists.',
    sheetErrorSheetsNet:'Cannot connect to Google Sheets. Check your internet connection and try again.',
    sheetErrorReadSize:'File is too large. Maximum 10MB. Try removing unused sheets or compressing the data.',
    sheetErrorReadFormat:'Unsupported file format. Please use .xlsx, .xls, or .csv.',
    fbTitle:           'Form Builder AI',
    fbSubtitle:        'Build dynamic forms with AI Interview or manually',
    fbModeInterview:   'AI Interview',
    fbModeManual:      'Manual',
    fbModeTemplate:    'Template',
    fbStartInterview:  'Start Interview',
    fbGenerating:      'AI is building your form...',
    fbPreview:         'Preview',
    fbEdit:            'Edit',
    fbEmbed:           'Embed',
    fbShare:           'Share',
    fbCopy:            'Copy',
    fbCopied:          'Copied!',
    fbSave:            'Save Form',
    fbSaved:           'Saved',
    fbSaving:          'Saving...',
    fbAddField:        '+ Add Field',
    fbAddSection:      '+ Add Section',
    fbDeleteField:     'Delete field',
    fbDeleteSection:   'Delete section',
    fbRequired:        'Required',
    fbFieldLabel:      'Field label',
    fbFieldType:       'Type',
    fbFieldPlaceholder:'Placeholder',
    fbFieldHint:       'Hint (optional)',
    fbOptions:         'Answer options',
    fbAddOption:       'Add option',
    fbSectionTitle:    'Section title',
    fbSectionDesc:     'Description',
    fbMinEntries:      'Min entries',
    fbMaxEntries:      'Max entries',
    fbSubmitLabel:     'Submit button text',
    fbSuccessMsg:      'Success message',
    fbFormTitle:       'Form title',
    fbFormDesc:        'Form description',
    fbStaticFields:    'Static Fields',
    fbDynSections:     'Dynamic Sections',
    fbSendToChat:      'Send to Chat',
    fbNewForm:         'New Form',
    fbEmbedCode:       'Embed Code',
    fbShareLink:       'Share Link',
    fbInterviewStep:   'Question',
    fbInterviewOf:     'of',
    fbSkip:            'Skip',
    fbTemplates:       'Choose Template',
  }},
  ar: { label: 'العربية', flag: '🇸🇦', ui: {
    newChat:'محادثة جديدة', searchPlaceholder:'بحث في المحادثات...', noConversations:'لا توجد محادثات بعد.\nابدأ محادثة جديدة!', noResults:'لم يتم العثور',
    suggestions: [
      '🏥|الصحة|أريد مناقشة مواضيع الصحة وأسلوب الحياة الصحي',
      '💰|المالية|ساعدني في تخطيط الأمور المالية والاستثمار',
      '📚|التعليم|أريد التعلم وفهم المواضيع الأكاديمية بعمق',
      '🌿|البيئة|ناقش قضايا البيئة والحياة الصديقة للبيئة',
      '📔|اليوميات|ساعدني في كتابة يوميات تأملية وتطوير الذات',
      '💼|المهنة|استشارة مهنية وتطوير مهني',
      '🍳|الطبخ|توصيات وصفات ونصائح الطبخ اليومية',
      '🧠|علم النفس|ناقش الصحة النفسية والتطوير الشخصي',
      ],
    model:'النموذج', systemPrompt:'موجه النظام', systemPromptPh:'تعيين سلوك المساعد...', clearAll:'حذف الكل',
    deleteConfirm:'انقر مرة أخرى للتأكيد', today:'اليوم', yesterday:'أمس', days7:'آخر 7 أيام',
    thisMonth:'هذا الشهر', older:'أقدم', messages:'رسائل', savedAuto:'حفظ تلقائي',
    typeMessage:'اكتب رسالة...', enterSend:'Enter للإرسال', shiftNewline:'Shift+Enter سطر جديد',
    webSearch:'تمت الإجابة من الإنترنت', admin:'مشرف', theme:'السمة', font:'الخط', language:'اللغة',
    settings:'الإعدادات', startChat:'اكتب رسالة لبدء المحادثة.',
    orSelectOld:'اختر محادثة قديمة أو ابدأ محادثة أكثر تحديداً.',
    prompt:'إدخال', completion:'إخراج', total:'المجموع',
    copy:'نسخ', copied:'تم النسخ!', listen:'استماع', stop:'إيقاف', retry:'إعادة المحاولة', share:'مشاركة', shareSource:'المصدر',
    errorApi:'خدمة الذكاء الاصطناعي غير متاحة', errorNetwork:'انقطع الاتصال', errorRate:'طلبات كثيرة جداً', errorOther:'مشكلة مؤقتة',
    dismiss:'إغلاق', errorTitle:'حدث خطأ', profile:'الملف الشخصي', logout:'تسجيل الخروج', myAccount:'حسابي',
    generatingImage:'جاري إنشاء الصورة...', imagePromptLabel:'النص:', downloadImage:'⬇ تحميل', imageError:'فشل إنشاء الصورة. حاول مرة أخرى.',
    viewFull:'🔍 عرض كامل', clickToZoom:'🔍 انقر للتكبير',
    continueBtnLabel:'متابعة الرد', continuingLabel:'جارٍ المتابعة...', truncatedNotice:'تم قطع الرد — انقر للمتابعة',
    upgradeTitle:'انتهت الحصة', upgradeDesc:'لقد استنفدت حصة الرموز الشهرية. قم بالترقية للاستمرار.', upgradeBtn:'ترقية الآن', upgradeDismiss:'لاحقاً',
    quotaExceeded:'لقد انتهت حصة الرموز.',
    aiDisclaimer: 'قد يرتكب الذكاء الاصطناعي أخطاء. تحقق من المعلومات المهمة.',
    deleteTitle:'حذف المحادثة؟', deleteDesc:'سيتم حذفه من سجل المحادثات.', deleteConfirmBtn:'حذف', deleteCancelBtn:'إلغاء',
    trialExpiredClose: 'إغلاق', trialExpiredViewHistory: 'عرض سجل المحادثات فقط',
    trialComingSoonTitle:'🚧 قريباً', trialComingSoonSub:'نظام الدفع في مرحلة التطوير النهائي.',
    trialComingSoonItem1:'تكامل بوابة الدفع قيد الاختبار', trialComingSoonItem2:'أمان المعاملات في عملية الاعتماد', trialComingSoonItem3:'ستُبلَّغ عبر البريد الإلكتروني عند الاستعداد',
    trialComingSoonCta:'فهمت، أخبرني لاحقاً', trialComingSoonFooter:'لا يزال بإمكانك قراءة جميع سجلات محادثاتك السابقة.',
    groupPickerTitle:'اختر ذكاءً اصطناعياً', groupFlashLabel:'Swift 3.1', groupFlashDesc:'سريع وخفيف', groupSmartLabel:'Pro 4.2', groupSmartDesc:'متوازن وموثوق', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'تحليل عميق', groupEliteLabel:'Max 5.0', groupEliteDesc:'أفضل قدرة',
    viewProfile:'عرض الملف الشخصي',
    sheetTitle:'تحليل البيانات', sheetBaris:'صف', sheetKolom:'عمود', sheetUploadTab:'📂 رفع Excel / CSV', sheetLinkTab:'🔗 رابط Google Sheets', sheetClickDrop:'انقر أو اسحب وأفلت الملف', sheetFormats:'.xlsx · .xls · .csv · حد أقصى 10MB', sheetSharingNote:'تأكد من ضبط مشاركة Google Sheets على', sheetSharingLink:'يمكن لأي شخص لديه الرابط العرض', sheetLoadingFile:'قراءة الملف…', sheetLoadingSheets:'جلب بيانات Google Sheets…', sheetErrorRead:'فشل قراءة الملف', sheetErrorSheets:'فشل جلب Google Sheets', sheetErrorAnalyze:'فشل تحليل البيانات', sheetRawToggleHide:'إخفاء', sheetRawToggleShow:'عرض', sheetRawLabel:'البيانات الخام (عينة {n} صف)', sheetKuotaLabel:'الحصة المستخدمة', sheetAiLabel:'🤖 رؤى الذكاء الاصطناعي', sheetRegenerate:'إعادة توليد', sheetAnalyzing:'جارٍ تحليل البيانات…', sheetAskPlaceholder:'اسأل شيئاً', sheetChangeFile:'تحليل ملف آخر', sheetTrendTitle:'اتجاه البيانات', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'Data Canvas', dcLembar:'ورقة', dcBaris:'صف', dcKolom:'عمود', dcAktif:'نشط', dcChat:'محادثة', dcAktifTitle:'نشط بالفعل', dcPakaiTitle:'استخدم في المحادثة', dcLagi:'+{n} أكثر', dcBukaSheets:'فتح Google Sheets', dcLoading:'جارٍ التحميل…', dcRefresh:'تحديث', dcGagal:'فشل التحميل', dcKosong:'لا توجد Data Canvas.', dcKosongSub:'رفع Excel أو Google Sheets.', dcTersimpan:'✓ محفوظ', dcBaruSaja:'الآن', dcMntLalu:'{n} دقيقة', dcJamLalu:'{n} ساعة', dcHariLalu:'{n} يوم',
    upgradePacketLabel:'ترقية الباقة', upgradePacketDesc:'وصول غير محدود وأسرع',
    trialBadgeExpired:'⚠ نفدت الحصة · ترقية', trialBadgePct:'{pct}% متبقٍ', trialBannerText:'{pct}% من الحصة متبقٍ.',
    trialQuotaTitle:'📊 حالة حصتك', trialQuotaSub:'{pct}% من حصتك لا تزال متاحة.', trialQuotaItem1:'💬 لا تزال قادراً على إرسال الرسائل.', trialQuotaItem2:'⚡ قم بالترقية للحصول على وصول غير محدود.', trialQuotaCta:'حسناً، فهمت',
    convFallbackTitle:'محادثة', trialExpiredErrMsg:'انتهت فترة التجربة المجانية. يرجى الترقية.', continuationInstr:'[نظام: تم قطع الرد. استمر من: "...{snippet}"] أكمل ردك.',
    userPreferences: 'تفضيلات المستخدم',
    scraperTitle:'وكيل استخراج الويب', scraperSubtitle:'قراءة وتحليل محتوى أي موقع',
    scraperUrlLabel:'رابط الموقع', scraperUrlPh:'https://example.com/...',
    scraperUrlError:'يجب أن يبدأ الرابط بـ https:// أو http://',
    scraperModeLabel:'وضع التحليل',
    scraperModeSum:'تلخيص', scraperModeSumDesc:'ملخص شامل',
    scraperModeExt:'استخراج', scraperModeExtDesc:'بيانات منظمة',
    scraperModeAna:'تحليل', scraperModeAnaDesc:'تحليل معمق',
    scraperModeQa:'سؤال', scraperModeQaDesc:'سؤال وجواب',
    scraperQaLabel:'سؤالك', scraperQaPh:'ماذا تريد أن تعرف من هذا الموقع؟',
    scraperBtnRun:'استخراج وتحليل', scraperBtnCancel:'إلغاء',
    scraperErrTitle:'فشل جلب المحتوى', scraperErrTips:'تأكد من أن الرابط متاح للعموم ولا يتطلب تسجيل دخول.',
    scraperStepsDone:'{n} خطوات مكتملة', scraperProcessing:'جارٍ المعالجة...',
    scraperResultLabel:'نتيجة التحليل',
    scraperSendChat:'إرسال إلى المحادثة', scraperCopy:'نسخ', scraperCopied:'تم النسخ!',
    scraperRetry:'إعادة', scraperAiAnalyzing:'الذكاء الاصطناعي يحلل...',
    scraperCancelled:'⏹ ألغيت',
    scraperWordCount:'{n} كلمة', scraperLinkCount:'{n} رابط', scraperImgCount:'{n} صورة',
    sheetErrorSheets401:'لا يمكن الوصول إلى Google Sheets (401). افتح Google Sheets → مشاركة → غيّر إلى "أي شخص لديه الرابط يمكنه العرض".',
    sheetErrorSheets403:'تم رفض الوصول (403). تأكد من أن المشاركة مضبوطة على "أي شخص لديه الرابط" وليس "مقيد".',
    sheetErrorSheets404:'لم يتم العثور على جدول البيانات (404). تحقق من صحة الرابط وتأكد من وجود الملف.',
    sheetErrorSheetsNet:'تعذر الاتصال بـ Google Sheets. تحقق من اتصالك بالإنترنت وحاول مرة أخرى.',
    sheetErrorReadSize:'الملف كبير جداً. الحد الأقصى 10MB. حاول حذف الأوراق غير الضرورية أو ضغط البيانات.',
    sheetErrorReadFormat:'صيغة الملف غير مدعومة. يرجى استخدام .xlsx أو .xls أو .csv.',
    fbTitle:'Form Builder AI', fbSubtitle:'إنشاء نماذج ديناميكية', fbModeInterview:'مقابلة AI', fbModeManual:'يدوي', fbModeTemplate:'قالب', fbStartInterview:'بدء المقابلة', fbGenerating:'AI يبني النموذج...', fbPreview:'معاينة', fbEdit:'تحرير', fbEmbed:'تضمين', fbShare:'مشاركة', fbCopy:'نسخ', fbCopied:'تم النسخ!', fbSave:'حفظ النموذج', fbSaved:'محفوظ', fbSaving:'جارٍ الحفظ...', fbAddField:'+ إضافة حقل', fbAddSection:'+ إضافة قسم', fbDeleteField:'حذف الحقل', fbDeleteSection:'حذف القسم', fbRequired:'مطلوب', fbFieldLabel:'تسمية الحقل', fbFieldType:'النوع', fbFieldPlaceholder:'نص توضيحي', fbFieldHint:'تلميح (اختياري)', fbOptions:'خيارات الإجابة', fbAddOption:'إضافة خيار', fbSectionTitle:'عنوان القسم', fbSectionDesc:'وصف', fbMinEntries:'الحد الأدنى', fbMaxEntries:'الحد الأقصى', fbSubmitLabel:'نص زر الإرسال', fbSuccessMsg:'رسالة النجاح', fbFormTitle:'عنوان النموذج', fbFormDesc:'وصف النموذج', fbStaticFields:'الحقول الثابتة', fbDynSections:'الأقسام الديناميكية', fbSendToChat:'إرسال إلى المحادثة', fbNewForm:'نموذج جديد', fbEmbedCode:'كود التضمين', fbShareLink:'رابط المشاركة', fbInterviewStep:'سؤال', fbInterviewOf:'من', fbSkip:'تخطي', fbTemplates:'اختر قالباً',
  }},
  zh: { label: '中文', flag: '🇨🇳', ui: {
    newChat:'新对话', searchPlaceholder:'搜索对话...', noConversations:'暂无对话。\n开始新对话！', noResults:'未找到',
    suggestions: [
      '🏥|健康|我想讨论健康话题和健康生活方式',
      '💰|理财|帮我规划个人财务和投资',
      '📚|教育|我想深入学习和理解学术话题',
      '🌿|环境|讨论环境问题和环保生活',
      '📔|日记|帮我写反思日记和个人成长记录',
      '💼|职业|职业咨询、简历建议和职业发展',
      '🍳|烹饪|食谱推荐和日常烹饪技巧',
      '🧠|心理学|讨论心理健康和个人发展',
      ],
    model:'模型', systemPrompt:'系统提示', systemPromptPh:'设置助手行为...', clearAll:'清除全部',
    deleteConfirm:'再次点击确认', today:'今天', yesterday:'昨天', days7:'最近7天',
    thisMonth:'本月', older:'更早', messages:'条消息', savedAuto:'自动保存',
    typeMessage:'输入消息...', enterSend:'Enter发送', shiftNewline:'Shift+Enter换行',
    webSearch:'已从网络获取答案', admin:'管理', theme:'主题', font:'字体', language:'语言',
    settings:'设置', startChat:'输入消息开始对话。', orSelectOld:'从侧边栏选择旧对话\n或开始更具体的对话。',
    prompt:'提示', completion:'完成', total:'总计',
    copy:'复制', copied:'已复制！', listen:'朗读', stop:'停止', retry:'重试', share:'分享', shareSource:'来源',
    errorApi:'AI服务不可用', errorNetwork:'连接断开', errorRate:'请求过多', errorOther:'临时问题',
    dismiss:'关闭', errorTitle:'发生错误', profile:'个人资料', logout:'退出登录', myAccount:'我的账户',
    generatingImage:'正在生成图片...', imagePromptLabel:'提示词:', downloadImage:'⬇ 下载', imageError:'图片生成失败，请重试。',
    viewFull:'🔍 查看全图', clickToZoom:'🔍 点击放大',
    continueBtnLabel:'继续响应', continuingLabel:'继续中...', truncatedNotice:'响应被截断 — 点击继续',
    upgradeTitle:'配额已用尽', upgradeDesc:'您的月度令牌配额已用完。升级套餐以无限制继续对话。', upgradeBtn:'立即升级', upgradeDismiss:'稍后再说',
    quotaExceeded:'您的令牌配额已用尽。',
    aiDisclaimer: 'AI 可能出错。请核实重要信息。',
    deleteTitle:'删除对话？', deleteDesc:'将从对话历史记录中删除。', deleteConfirmBtn:'删除', deleteCancelBtn:'取消',
    trialExpiredClose:'关闭', trialExpiredViewHistory:'仅查看聊天记录',
    trialComingSoonTitle:'🚧 即将推出', trialComingSoonSub:'我们的支付系统正在最终开发阶段。', trialComingSoonItem1:'支付网关集成正在测试中', trialComingSoonItem2:'交易安全正在认证过程中', trialComingSoonItem3:'准备就绪后将通过邮件通知您', trialComingSoonCta:'明白了，稍后通知我', trialComingSoonFooter:'您仍然可以查看所有之前的聊天记录。',
    groupPickerTitle:'选择AI智能', groupFlashLabel:'Swift 3.1', groupFlashDesc:'快速轻量', groupSmartLabel:'Pro 4.2', groupSmartDesc:'均衡可靠', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'深度分析', groupEliteLabel:'Max 5.0', groupEliteDesc:'最佳能力',
    viewProfile:'查看个人资料',
    sheetTitle:'数据分析', sheetBaris:'行', sheetKolom:'列', sheetUploadTab:'📂 上传 Excel / CSV', sheetLinkTab:'🔗 Google Sheets 链接', sheetClickDrop:'点击或拖放文件', sheetFormats:'.xlsx · .xls · .csv · 最大 10MB', sheetSharingNote:'确保 Google Sheets 共享设置为', sheetSharingLink:'任何人都可以查看', sheetLoadingFile:'正在读取文件…', sheetLoadingSheets:'正在获取 Google Sheets…', sheetErrorRead:'读取文件失败', sheetErrorSheets:'获取 Google Sheets 失败', sheetErrorAnalyze:'数据分析失败', sheetRawToggleHide:'隐藏', sheetRawToggleShow:'查看', sheetRawLabel:'原始数据（样本 {n} 行）', sheetKuotaLabel:'已用配额', sheetAiLabel:'🤖 AI 洞察', sheetRegenerate:'重新生成', sheetAnalyzing:'正在分析数据…', sheetAskPlaceholder:'提问', sheetChangeFile:'分析其他文件', sheetTrendTitle:'数据趋势', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'数据画布', dcLembar:'张', dcBaris:'行', dcKolom:'列', dcAktif:'激活', dcChat:'聊天', dcAktifTitle:'已在聊天中激活', dcPakaiTitle:'在聊天中使用', dcLagi:'+{n} 更多', dcBukaSheets:'打开 Google Sheets', dcLoading:'加载中…', dcRefresh:'刷新', dcGagal:'加载失败', dcKosong:'还没有数据画布。', dcKosongSub:'上传 Excel 或 Google Sheets。', dcTersimpan:'✓ 已保存', dcBaruSaja:'刚刚', dcMntLalu:'{n} 分钟前', dcJamLalu:'{n} 小时前', dcHariLalu:'{n} 天前',
    upgradePacketLabel:'升级套餐', upgradePacketDesc:'无限使用，响应更快',
    trialBadgeExpired:'⚠ 配额已用完 · 升级', trialBadgePct:'剩余 {pct}%', trialBannerText:'剩余 {pct}% 配额。',
    trialQuotaTitle:'📊 您的配额状态', trialQuotaSub:'您还有 {pct}% 的配额可用。', trialQuotaItem1:'💬 您仍然可以发送消息和提问。', trialQuotaItem2:'⚡ 升级以获得无限配额。', trialQuotaCta:'好的，明白了',
    convFallbackTitle:'对话', trialExpiredErrMsg:'免费试用期已结束，请升级。', continuationInstr:'[系统：回复被截断。从"...{snippet}"继续] 请继续您的回复。',
    userPreferences: '用户偏好',
    scraperTitle:'网页抓取代理', scraperSubtitle:'读取并分析任何网站内容',
    scraperUrlLabel:'网站URL', scraperUrlPh:'https://example.com/...',
    scraperUrlError:'URL必须以https://或http://开头',
    scraperModeLabel:'分析模式',
    scraperModeSum:'摘要', scraperModeSumDesc:'综合摘要',
    scraperModeExt:'提取', scraperModeExtDesc:'结构化数据',
    scraperModeAna:'分析', scraperModeAnaDesc:'深度分析',
    scraperModeQa:'问答', scraperModeQaDesc:'问题解答',
    scraperQaLabel:'您的问题', scraperQaPh:'您想从这个网站了解什么？',
    scraperBtnRun:'抓取并分析', scraperBtnCancel:'取消',
    scraperErrTitle:'获取内容失败', scraperErrTips:'请确保URL可公开访问且无需登录。',
    scraperStepsDone:'{n}个步骤完成', scraperProcessing:'处理中...',
    scraperResultLabel:'分析结果',
    scraperSendChat:'发送到聊天', scraperCopy:'复制', scraperCopied:'已复制！',
    scraperRetry:'重试', scraperAiAnalyzing:'AI正在分析...',
    scraperCancelled:'⏹ 已取消',
    scraperWordCount:'{n}个词', scraperLinkCount:'{n}个链接', scraperImgCount:'{n}张图片',
    sheetErrorSheets401:'无法访问 Google Sheets (401)。打开 Google Sheets → 共享 → 设置为"任何有链接的人都可以查看"。',
    sheetErrorSheets403:'访问被拒绝 (403)。确保共享设置为"任何有链接的人"，而不是"受限"。',
    sheetErrorSheets404:'找不到电子表格 (404)。请检查链接是否正确以及文件是否仍然存在。',
    sheetErrorSheetsNet:'无法连接到 Google Sheets。请检查您的网络连接后重试。',
    sheetErrorReadSize:'文件太大。最大 10MB。请尝试删除不需要的工作表或压缩数据。',
    sheetErrorReadFormat:'不支持的文件格式。请使用 .xlsx、.xls 或 .csv。',
    fbTitle:'Form Builder AI', fbSubtitle:'用AI访谈或手动创建动态表单', fbModeInterview:'AI访谈', fbModeManual:'手动', fbModeTemplate:'模板', fbStartInterview:'开始访谈', fbGenerating:'AI正在构建表单...', fbPreview:'预览', fbEdit:'编辑', fbEmbed:'嵌入', fbShare:'分享', fbCopy:'复制', fbCopied:'已复制！', fbSave:'保存表单', fbSaved:'已保存', fbSaving:'保存中...', fbAddField:'+ 添加字段', fbAddSection:'+ 添加部分', fbDeleteField:'删除字段', fbDeleteSection:'删除部分', fbRequired:'必填', fbFieldLabel:'字段标签', fbFieldType:'类型', fbFieldPlaceholder:'占位符', fbFieldHint:'提示（可选）', fbOptions:'答案选项', fbAddOption:'添加选项', fbSectionTitle:'部分标题', fbSectionDesc:'描述', fbMinEntries:'最少条目', fbMaxEntries:'最多条目', fbSubmitLabel:'提交按钮文字', fbSuccessMsg:'成功消息', fbFormTitle:'表单标题', fbFormDesc:'表单描述', fbStaticFields:'静态字段', fbDynSections:'动态部分', fbSendToChat:'发送到聊天', fbNewForm:'新建表单', fbEmbedCode:'嵌入代码', fbShareLink:'分享链接', fbInterviewStep:'问题', fbInterviewOf:'共', fbSkip:'跳过', fbTemplates:'选择模板',
  }},
  ja: { label: '日本語', flag: '🇯🇵', ui: {
    newChat:'新規チャット', searchPlaceholder:'会話を検索...', noConversations:'まだ会話がありません。\n新しいチャットを始めましょう！', noResults:'見つかりません',
    suggestions: [
      '🏥|健康|健康と健康的なライフスタイルについて相談したいです',
      '💰|財務|個人財務と投資の計画を立てるのを手伝ってください',
      '📚|教育|学術的なトピックを深く学びたいです',
      '🌿|環境|環境問題とエコな生活について話し合いましょう',
      '📔|日記|反省日記と個人成長の記録を書く手伝いをしてください',
      '💼|キャリア|キャリア相談、履歴書、職業発展について',
      '🍳|料理|レシピの提案と日常料理のコツ',
      '🧠|心理学|メンタルヘルスと自己啓発について話し合う',
      ],
    model:'モデル', systemPrompt:'システムプロンプト', systemPromptPh:'アシスタントの動作を設定...', clearAll:'全て削除',
    deleteConfirm:'もう一度クリックして確認', today:'今日', yesterday:'昨日', days7:'過去7日間',
    thisMonth:'今月', older:'それ以前', messages:'メッセージ', savedAuto:'自動保存',
    typeMessage:'メッセージを入力...', enterSend:'Enterで送信', shiftNewline:'Shift+Enterで改行',
    webSearch:'インターネットから回答', admin:'管理', theme:'テーマ', font:'フォント', language:'言語',
    settings:'設定', startChat:'メッセージを入力して会話を始めましょう。', orSelectOld:'サイドバーから古い会話を選ぶか\nより具体的な話題で始めましょう。',
    prompt:'プロンプト', completion:'完了', total:'合計',
    copy:'コピー', copied:'コピー完了！', listen:'再生', stop:'停止', retry:'再試行', share:'シェア', shareSource:'ソース',
    errorApi:'AIサービス利用不可', errorNetwork:'接続が切れました', errorRate:'リクエストが多すぎます', errorOther:'一時的な問題',
    dismiss:'閉じる', errorTitle:'エラー発生', profile:'プロフィール', logout:'ログアウト', myAccount:'マイアカウント',
    generatingImage:'画像を生成中...', imagePromptLabel:'プロンプト:', downloadImage:'⬇ ダウンロード', imageError:'画像の生成に失敗しました。再試行してください。',
    viewFull:'🔍 全画面表示', clickToZoom:'🔍 クリックで拡大',
    continueBtnLabel:'応答を続ける', continuingLabel:'続行中...', truncatedNotice:'応答が途切れました — クリックして続行',
    upgradeTitle:'クォータ超過', upgradeDesc:'月間トークンクォータに達しました。', upgradeBtn:'今すぐアップグレード', upgradeDismiss:'後で',
    quotaExceeded:'トークンクォータが超過しました。',
    aiDisclaimer: 'AIは間違いを犯す可能性があります。重要な情報を確認してください。',
    deleteTitle:'会話を削除？', deleteDesc:'が会話履歴から削除されます。', deleteConfirmBtn:'削除', deleteCancelBtn:'キャンセル',
    trialExpiredClose:'閉じる', trialExpiredViewHistory:'会話履歴だけ見る',
    trialComingSoonTitle:'🚧 近日公開', trialComingSoonSub:'決済システムは最終開発段階にあります。', trialComingSoonItem1:'決済ゲートウェイの統合をテスト中', trialComingSoonItem2:'取引セキュリティの認証プロセス中', trialComingSoonItem3:'準備が整い次第メールでお知らせします', trialComingSoonCta:'わかりました、後で通知して', trialComingSoonFooter:'以前のすべての会話履歴は引き続き閲覧できます。',
    groupPickerTitle:'AIを選択', groupFlashLabel:'Swift 3.1', groupFlashDesc:'高速・軽量', groupSmartLabel:'Pro 4.2', groupSmartDesc:'バランス重視', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'深い分析', groupEliteLabel:'Max 5.0', groupEliteDesc:'最高性能',
    viewProfile:'プロフィールを見る',
    sheetTitle:'データ分析', sheetBaris:'行', sheetKolom:'列', sheetUploadTab:'📂 Excel / CSV アップロード', sheetLinkTab:'🔗 Google Sheets リンク', sheetClickDrop:'クリックまたはドラッグ＆ドロップ', sheetFormats:'.xlsx · .xls · .csv · 最大 10MB', sheetSharingNote:'Google Sheets の共有設定を', sheetSharingLink:'リンクを知っている全員が閲覧可 に設定してください', sheetLoadingFile:'ファイルを読み込み中…', sheetLoadingSheets:'Google Sheets を取得中…', sheetErrorRead:'ファイルの読み込みに失敗しました', sheetErrorSheets:'Google Sheets の取得に失敗しました', sheetErrorAnalyze:'データ分析に失敗しました', sheetRawToggleHide:'非表示', sheetRawToggleShow:'表示', sheetRawLabel:'生データ（サンプル {n} 行）', sheetKuotaLabel:'使用済みクォータ', sheetAiLabel:'🤖 AI インサイト', sheetRegenerate:'再生成', sheetAnalyzing:'データを分析中…', sheetAskPlaceholder:'質問してください', sheetChangeFile:'別のファイルを分析', sheetTrendTitle:'データトレンド', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'データキャンバス', dcLembar:'枚', dcBaris:'行', dcKolom:'列', dcAktif:'アクティブ', dcChat:'チャット', dcAktifTitle:'既にアクティブ', dcPakaiTitle:'チャットで使用', dcLagi:'+{n} 件', dcBukaSheets:'Google Sheets を開く', dcLoading:'読み込み中…', dcRefresh:'更新', dcGagal:'読み込み失敗', dcKosong:'データキャンバスがありません。', dcKosongSub:'Excel または Google Sheets をアップロードしてください。', dcTersimpan:'✓ 保存済み', dcBaruSaja:'たった今', dcMntLalu:'{n} 分前', dcJamLalu:'{n} 時間前', dcHariLalu:'{n} 日前',
    upgradePacketLabel:'プランをアップグレード', upgradePacketDesc:'無制限アクセスと高速レスポンス',
    trialBadgeExpired:'⚠ 上限超過 · アップグレード', trialBadgePct:'残り {pct}%', trialBannerText:'残り {pct}% のクォータ。',
    trialQuotaTitle:'📊 クォータの状況', trialQuotaSub:'まだ {pct}% のクォータが残っています。', trialQuotaItem1:'💬 まだメッセージを送ることができます。', trialQuotaItem2:'⚡ アップグレードで無制限クォータを。', trialQuotaCta:'わかりました',
    convFallbackTitle:'会話', trialExpiredErrMsg:'無料トライアルが終了しました。アップグレードしてください。', continuationInstr:'[システム: 応答が途切れました。「...{snippet}」から続けてください] 応答を続けてください。',
    userPreferences: 'ユーザー設定',
    scraperTitle:'Webスクレイパー', scraperSubtitle:'任意のウェブサイトを読み取り分析',
    scraperUrlLabel:'URL', scraperUrlPh:'https://example.com/...',
    scraperUrlError:'URLはhttps://またはhttp://で始まる必要があります',
    scraperModeLabel:'分析モード',
    scraperModeSum:'要約', scraperModeSumDesc:'包括的な要約',
    scraperModeExt:'抽出', scraperModeExtDesc:'構造化データ',
    scraperModeAna:'分析', scraperModeAnaDesc:'詳細分析',
    scraperModeQa:'質問', scraperModeQaDesc:'Q&A',
    scraperQaLabel:'ご質問', scraperQaPh:'このサイトについて何を知りたいですか？',
    scraperBtnRun:'スクレイプ＆分析', scraperBtnCancel:'キャンセル',
    scraperErrTitle:'コンテンツ取得失敗', scraperErrTips:'URLが公開アクセス可能でログイン不要であることを確認してください。',
    scraperStepsDone:'{n}ステップ完了', scraperProcessing:'処理中...',
    scraperResultLabel:'分析結果',
    scraperSendChat:'チャットへ送信', scraperCopy:'コピー', scraperCopied:'コピー済み！',
    scraperRetry:'再試行', scraperAiAnalyzing:'AIが分析中...',
    scraperCancelled:'⏹ キャンセル済み',
    scraperWordCount:'{n}語', scraperLinkCount:'{n}リンク', scraperImgCount:'{n}画像',
    sheetErrorSheets401:'Google Sheets にアクセスできません (401)。Google Sheets を開き → 共有 → 「リンクを知っている全員が閲覧可」に変更してください。',
    sheetErrorSheets403:'アクセスが拒否されました (403)。共有設定が「リンクを知っている全員」になっていることを確認してください（「制限付き」ではなく）。',
    sheetErrorSheets404:'スプレッドシートが見つかりません (404)。リンクが正しいか、ファイルがまだ存在するか確認してください。',
    sheetErrorSheetsNet:'Google Sheets に接続できません。インターネット接続を確認してから再試行してください。',
    sheetErrorReadSize:'ファイルが大きすぎます。最大 10MB です。不要なシートを削除するかデータを圧縮してみてください。',
    sheetErrorReadFormat:'サポートされていないファイル形式です。.xlsx、.xls、または .csv を使用してください。',
    fbTitle:'Form Builder AI', fbSubtitle:'AIインタビューまたは手動で動的フォームを作成', fbModeInterview:'AIインタビュー', fbModeManual:'手動', fbModeTemplate:'テンプレート', fbStartInterview:'インタビュー開始', fbGenerating:'AIがフォームを作成中...', fbPreview:'プレビュー', fbEdit:'編集', fbEmbed:'埋め込み', fbShare:'シェア', fbCopy:'コピー', fbCopied:'コピー完了！', fbSave:'フォームを保存', fbSaved:'保存済み', fbSaving:'保存中...', fbAddField:'+ フィールド追加', fbAddSection:'+ セクション追加', fbDeleteField:'フィールド削除', fbDeleteSection:'セクション削除', fbRequired:'必須', fbFieldLabel:'フィールドラベル', fbFieldType:'タイプ', fbFieldPlaceholder:'プレースホルダー', fbFieldHint:'ヒント（任意）', fbOptions:'回答オプション', fbAddOption:'オプション追加', fbSectionTitle:'セクションタイトル', fbSectionDesc:'説明', fbMinEntries:'最小エントリ', fbMaxEntries:'最大エントリ', fbSubmitLabel:'送信ボタンテキスト', fbSuccessMsg:'成功メッセージ', fbFormTitle:'フォームタイトル', fbFormDesc:'フォーム説明', fbStaticFields:'静的フィールド', fbDynSections:'動的セクション', fbSendToChat:'チャットへ送信', fbNewForm:'新規フォーム', fbEmbedCode:'埋め込みコード', fbShareLink:'共有リンク', fbInterviewStep:'質問', fbInterviewOf:'/', fbSkip:'スキップ', fbTemplates:'テンプレート選択',
  }},
  ko: { label: '한국어', flag: '🇰🇷', ui: {
    newChat:'새 채팅', searchPlaceholder:'대화 검색...', noConversations:'대화가 없습니다.\n새 채팅을 시작하세요!', noResults:'찾을 수 없음',
    suggestions: [
      '🏥|건강|건강 주제와 건강한 생활 방식에 대해 상담하고 싶어요',
      '💰|재무|개인 재무 계획과 투자를 도와주세요',
      '📚|교육|학문적 주제를 깊이 배우고 싶어요',
      '🌿|환경|환경 문제와 친환경 생활에 대해 이야기해요',
      '📔|일기|성찰 일기와 자기 성장 기록 작성을 도와주세요',
      '💼|커리어|커리어 상담, 이력서, 직업 개발에 대해',
      '🍳|요리|레시피 추천과 일상 요리 팁',
      '🧠|심리학|정신 건강과 자기 계발에 대해 이야기해요',
      ],
    model:'모델', systemPrompt:'시스템 프롬프트', systemPromptPh:'어시스턴트 동작 설정...', clearAll:'전체 삭제',
    deleteConfirm:'다시 클릭하여 확인', today:'오늘', yesterday:'어제', days7:'최근 7일',
    thisMonth:'이번 달', older:'더 오래된', messages:'메시지', savedAuto:'자동 저장됨',
    typeMessage:'메시지 입력...', enterSend:'Enter로 전송', shiftNewline:'Shift+Enter 줄바꿈',
    webSearch:'인터넷에서 답변', admin:'관리자', theme:'테마', font:'글꼴', language:'언어',
    settings:'설정', startChat:'메시지를 입력하여 대화를 시작하세요.', orSelectOld:'사이드바에서 이전 대화를 선택하거나\n더 구체적인 주제로 시작하세요.',
    prompt:'프롬프트', completion:'완성', total:'합계',
    copy:'복사', copied:'복사됨!', listen:'듣기', stop:'중지', retry:'재시도', share:'공유', shareSource:'출처',
    errorApi:'AI 서비스를 사용할 수 없음', errorNetwork:'연결 끊김', errorRate:'요청이 너무 많음', errorOther:'일시적 문제',
    dismiss:'닫기', errorTitle:'오류 발생', profile:'프로필', logout:'로그아웃', myAccount:'내 계정',
    generatingImage:'이미지 생성 중...', imagePromptLabel:'프롬프트:', downloadImage:'⬇ 다운로드', imageError:'이미지 생성 실패. 다시 시도하세요.',
    viewFull:'🔍 전체 보기', clickToZoom:'🔍 클릭하여 확대',
    continueBtnLabel:'응답 계속하기', continuingLabel:'계속 중...', truncatedNotice:'응답이 잘렸습니다 — 클릭하여 계속',
    upgradeTitle:'할당량 초과', upgradeDesc:'월간 토큰 할당량이 소진되었습니다.', upgradeBtn:'지금 업그레이드', upgradeDismiss:'나중에',
    quotaExceeded:'토큰 할당량이 초과되었습니다.',
    aiDisclaimer: 'AI는 실수할 수 있습니다. 중요한 정보를 확인하세요.',
    deleteTitle:'대화 삭제?', deleteDesc:'이(가) 대화 기록에서 삭제됩니다.', deleteConfirmBtn:'삭제', deleteCancelBtn:'취소',
    trialExpiredClose:'닫기', trialExpiredViewHistory:'채팅 기록만 보기',
    trialComingSoonTitle:'🚧 곧 출시', trialComingSoonSub:'결제 시스템이 최종 개발 단계에 있어요.', trialComingSoonItem1:'결제 게이트웨이 통합 테스트 중', trialComingSoonItem2:'거래 보안 인증 절차 중', trialComingSoonItem3:'준비되면 이메일로 알려드릴게요', trialComingSoonCta:'알겠어요, 나중에 알려주세요', trialComingSoonFooter:'이전 채팅 기록은 계속 확인할 수 있어요.',
    groupPickerTitle:'AI 지능 선택', groupFlashLabel:'Swift 3.1', groupFlashDesc:'빠르고 가볍게', groupSmartLabel:'Pro 4.2', groupSmartDesc:'균형잡힌 성능', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'깊은 분석', groupEliteLabel:'Max 5.0', groupEliteDesc:'최고 성능',
    viewProfile:'프로필 보기',
    sheetTitle:'데이터 분석', sheetBaris:'행', sheetKolom:'열', sheetUploadTab:'📂 Excel / CSV 업로드', sheetLinkTab:'🔗 Google Sheets 링크', sheetClickDrop:'클릭하거나 드래그 앤 드롭', sheetFormats:'.xlsx · .xls · .csv · 최대 10MB', sheetSharingNote:'Google Sheets 공유 설정을', sheetSharingLink:'링크가 있는 모든 사용자 볼 수 있음 으로 설정하세요', sheetLoadingFile:'파일 읽는 중…', sheetLoadingSheets:'Google Sheets 가져오는 중…', sheetErrorRead:'파일 읽기 실패', sheetErrorSheets:'Google Sheets 가져오기 실패', sheetErrorAnalyze:'데이터 분석 실패', sheetRawToggleHide:'숨기기', sheetRawToggleShow:'보기', sheetRawLabel:'원시 데이터 (샘플 {n}행)', sheetKuotaLabel:'사용된 할당량', sheetAiLabel:'🤖 AI 인사이트', sheetRegenerate:'재생성', sheetAnalyzing:'데이터 분석 중…', sheetAskPlaceholder:'질문하세요', sheetChangeFile:'다른 파일 분석', sheetTrendTitle:'데이터 트렌드', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'데이터 캔버스', dcLembar:'장', dcBaris:'행', dcKolom:'열', dcAktif:'활성', dcChat:'채팅', dcAktifTitle:'채팅에서 이미 활성', dcPakaiTitle:'채팅에서 사용', dcLagi:'+{n} 더', dcBukaSheets:'Google Sheets 열기', dcLoading:'로딩 중…', dcRefresh:'새로고침', dcGagal:'로드 실패', dcKosong:'아직 데이터 캔버스가 없습니다.', dcKosongSub:'Excel 또는 Google Sheets를 업로드하세요.', dcTersimpan:'✓ 저장됨', dcBaruSaja:'방금', dcMntLalu:'{n}분 전', dcJamLalu:'{n}시간 전', dcHariLalu:'{n}일 전',
    upgradePacketLabel:'플랜 업그레이드', upgradePacketDesc:'무제한 접속 & 빠른 응답',
    trialBadgeExpired:'⚠ 할당량 초과 · 업그레이드', trialBadgePct:'{pct}% 남음', trialBannerText:'할당량 {pct}% 남음.',
    trialQuotaTitle:'📊 내 할당량 현황', trialQuotaSub:'아직 {pct}%의 할당량이 남아 있어요.', trialQuotaItem1:'💬 아직 메시지를 보낼 수 있어요.', trialQuotaItem2:'⚡ 업그레이드로 무제한 할당량을 이용하세요.', trialQuotaCta:'알겠어요',
    convFallbackTitle:'대화', trialExpiredErrMsg:'무료 체험 기간이 종료됐어요. 업그레이드해주세요.', continuationInstr:'[시스템: 응답이 잘렸습니다. "...{snippet}"에서 계속하세요] 응답을 이어가세요.',
    userPreferences: '사용자 환경설정',
    scraperTitle:'웹 스크래퍼', scraperSubtitle:'모든 웹사이트 콘텐츠 읽기 및 분석',
    scraperUrlLabel:'웹사이트 URL', scraperUrlPh:'https://example.com/...',
    scraperUrlError:'URL은 https:// 또는 http://로 시작해야 합니다',
    scraperModeLabel:'분석 모드',
    scraperModeSum:'요약', scraperModeSumDesc:'포괄적 요약',
    scraperModeExt:'추출', scraperModeExtDesc:'구조화된 데이터',
    scraperModeAna:'분석', scraperModeAnaDesc:'심층 분석',
    scraperModeQa:'질문', scraperModeQaDesc:'Q&A',
    scraperQaLabel:'질문', scraperQaPh:'이 웹사이트에서 무엇을 알고 싶으신가요?',
    scraperBtnRun:'스크래핑 & 분석', scraperBtnCancel:'취소',
    scraperErrTitle:'콘텐츠 가져오기 실패', scraperErrTips:'URL이 공개적으로 접근 가능하고 로그인이 필요하지 않은지 확인하세요.',
    scraperStepsDone:'{n}단계 완료', scraperProcessing:'처리 중...',
    scraperResultLabel:'분석 결과',
    scraperSendChat:'채팅으로 보내기', scraperCopy:'복사', scraperCopied:'복사됨!',
    scraperRetry:'재시도', scraperAiAnalyzing:'AI가 분석 중...',
    scraperCancelled:'⏹ 취소됨',
    scraperWordCount:'{n}단어', scraperLinkCount:'{n}링크', scraperImgCount:'{n}이미지',
    sheetErrorSheets401:'Google Sheets에 접근할 수 없습니다 (401). Google Sheets 열기 → 공유 → "링크가 있는 모든 사용자가 볼 수 있음"으로 변경하세요.',
    sheetErrorSheets403:'접근이 거부되었습니다 (403). 공유 설정이 "링크가 있는 모든 사용자"로 되어 있는지 확인하세요("제한됨"이 아닌).',
    sheetErrorSheets404:'스프레드시트를 찾을 수 없습니다 (404). 링크가 올바른지, 파일이 아직 존재하는지 확인하세요.',
    sheetErrorSheetsNet:'Google Sheets에 연결할 수 없습니다. 인터넷 연결을 확인하고 다시 시도하세요.',
    sheetErrorReadSize:'파일이 너무 큽니다. 최대 10MB입니다. 불필요한 시트를 삭제하거나 데이터를 압축해 보세요.',
    sheetErrorReadFormat:'지원되지 않는 파일 형식입니다. .xlsx, .xls 또는 .csv를 사용하세요。',
    fbTitle:'Form Builder AI', fbSubtitle:'AI 인터뷰 또는 수동으로 동적 양식 생성', fbModeInterview:'AI 인터뷰', fbModeManual:'수동', fbModeTemplate:'템플릿', fbStartInterview:'인터뷰 시작', fbGenerating:'AI가 양식 생성 중...', fbPreview:'미리보기', fbEdit:'편집', fbEmbed:'임베드', fbShare:'공유', fbCopy:'복사', fbCopied:'복사됨!', fbSave:'양식 저장', fbSaved:'저장됨', fbSaving:'저장 중...', fbAddField:'+ 필드 추가', fbAddSection:'+ 섹션 추가', fbDeleteField:'필드 삭제', fbDeleteSection:'섹션 삭제', fbRequired:'필수', fbFieldLabel:'필드 레이블', fbFieldType:'유형', fbFieldPlaceholder:'플레이스홀더', fbFieldHint:'힌트 (선택)', fbOptions:'답변 옵션', fbAddOption:'옵션 추가', fbSectionTitle:'섹션 제목', fbSectionDesc:'설명', fbMinEntries:'최소 항목', fbMaxEntries:'최대 항목', fbSubmitLabel:'제출 버튼 텍스트', fbSuccessMsg:'성공 메시지', fbFormTitle:'양식 제목', fbFormDesc:'양식 설명', fbStaticFields:'정적 필드', fbDynSections:'동적 섹션', fbSendToChat:'채팅으로 보내기', fbNewForm:'새 양식', fbEmbedCode:'임베드 코드', fbShareLink:'공유 링크', fbInterviewStep:'질문', fbInterviewOf:'/', fbSkip:'건너뛰기', fbTemplates:'템플릿 선택',
  }},
  es: { label: 'Español', flag: '🇪🇸', ui: {
    newChat:'Nueva Chat', searchPlaceholder:'Buscar conversaciones...', noConversations:'No hay conversaciones.\n¡Empieza una nueva!', noResults:'No encontrado',
    suggestions: [
      '🏥|Salud|Quiero hablar sobre salud y un estilo de vida saludable',
      '💰|Finanzas|Ayúdame a planificar las finanzas personales e inversiones',
      '📚|Educación|Quiero aprender y entender temas académicos en profundidad',
      '🌿|Medio Ambiente|Discutir problemas ambientales y vida ecológica',
      '📔|Diario|Ayúdame a escribir un diario reflexivo y de crecimiento personal',
      '💼|Carrera|Consultoría profesional, CV y desarrollo profesional',
      '🍳|Cocina|Recomendaciones de recetas y consejos de cocina diaria',
      '🧠|Psicología|Discutir salud mental y desarrollo personal',
      ],
    model:'Modelo', systemPrompt:'Prompt del sistema', systemPromptPh:'Configurar el asistente...', clearAll:'Borrar todo',
    deleteConfirm:'Clic de nuevo para confirmar', today:'Hoy', yesterday:'Ayer', days7:'Últimos 7 días',
    thisMonth:'Este mes', older:'Más antiguo', messages:'mensajes', savedAuto:'Guardado automático',
    typeMessage:'Escribe un mensaje...', enterSend:'Enter para enviar', shiftNewline:'Shift+Enter nueva línea',
    webSearch:'Respondido desde internet', admin:'Admin', theme:'Tema', font:'Fuente', language:'Idioma',
    settings:'Ajustes', startChat:'Escribe un mensaje para empezar.', orSelectOld:'Selecciona una conversación antigua\no inicia una conversación más específica.',
    prompt:'Prompt', completion:'Completado', total:'Total',
    copy:'Copiar', copied:'¡Copiado!', listen:'Escuchar', stop:'Detener', retry:'Reintentar', share:'Compartir', shareSource:'Fuente',
    errorApi:'Servicio de IA no disponible', errorNetwork:'Conexión perdida', errorRate:'Demasiadas solicitudes', errorOther:'Problema temporal',
    dismiss:'Cerrar', errorTitle:'Error', profile:'Perfil', logout:'Cerrar sesión', myAccount:'Mi cuenta',
    generatingImage:'Generando imagen...', imagePromptLabel:'Prompt:', downloadImage:'⬇ Descargar', imageError:'Error al generar imagen. Inténtalo de nuevo.',
    viewFull:'🔍 Ver completo', clickToZoom:'🔍 Clic para ampliar',
    continueBtnLabel:'Continuar Respuesta', continuingLabel:'Continuando...', truncatedNotice:'Respuesta cortada — clic para continuar',
    upgradeTitle:'Cuota Agotada', upgradeDesc:'Tu cuota mensual de tokens se ha agotado.', upgradeBtn:'Actualizar Ahora', upgradeDismiss:'Quizás Luego',
    quotaExceeded:'Tu cuota de tokens se ha agotado.',
    aiDisclaimer: 'La IA puede cometer errores. Verifica la información importante.',
    deleteTitle:'¿Eliminar chat?', deleteDesc:'será eliminado de tu historial de conversaciones.', deleteConfirmBtn:'Eliminar', deleteCancelBtn:'Cancelar',
    trialExpiredClose:'Cerrar', trialExpiredViewHistory:'Solo ver historial de chat',
    trialComingSoonTitle:'🚧 Próximamente', trialComingSoonSub:'Nuestro sistema de pago está en desarrollo final.', trialComingSoonItem1:'Integración de pasarela de pago en pruebas', trialComingSoonItem2:'Seguridad de transacciones en proceso de certificación', trialComingSoonItem3:'Te notificaremos por email cuando esté listo', trialComingSoonCta:'Entendido, avísame después', trialComingSoonFooter:'Aún puedes leer todo tu historial de chat anterior.',
    groupPickerTitle:'Elige Inteligencia IA', groupFlashLabel:'Swift 3.1', groupFlashDesc:'Rápido y ligero', groupSmartLabel:'Pro 4.2', groupSmartDesc:'Equilibrado y fiable', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'Análisis profundo', groupEliteLabel:'Max 5.0', groupEliteDesc:'Máxima capacidad',
    viewProfile:'Ver perfil',
    sheetTitle:'Análisis de datos', sheetBaris:'filas', sheetKolom:'columnas', sheetUploadTab:'📂 Subir Excel / CSV', sheetLinkTab:'🔗 Enlace Google Sheets', sheetClickDrop:'Haz clic o arrastra y suelta el archivo', sheetFormats:'.xlsx · .xls · .csv · máx 10MB', sheetSharingNote:'Asegúrate de que el acceso de Google Sheets esté configurado como', sheetSharingLink:'Cualquier persona con el enlace puede ver', sheetLoadingFile:'Leyendo archivo…', sheetLoadingSheets:'Obteniendo Google Sheets…', sheetErrorRead:'Error al leer el archivo', sheetErrorSheets:'Error al obtener Google Sheets', sheetErrorAnalyze:'Error al analizar los datos', sheetRawToggleHide:'Ocultar', sheetRawToggleShow:'Ver', sheetRawLabel:'datos sin procesar (muestra {n} filas)', sheetKuotaLabel:'Cuota utilizada', sheetAiLabel:'🤖 AI Insights', sheetRegenerate:'Regenerar', sheetAnalyzing:'Analizando datos…', sheetAskPlaceholder:'Pregunta algo', sheetChangeFile:'Analizar otro archivo', sheetTrendTitle:'Tendencia de datos', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'Lienzo de datos', dcLembar:'hojas', dcBaris:'filas', dcKolom:'columnas', dcAktif:'Activo', dcChat:'Chat', dcAktifTitle:'Ya activo en el chat', dcPakaiTitle:'Usar en el chat', dcLagi:'+{n} más', dcBukaSheets:'Abrir Google Sheets', dcLoading:'Cargando…', dcRefresh:'Actualizar', dcGagal:'Error al cargar', dcKosong:'No hay lienzo de datos.', dcKosongSub:'Sube Excel o Google Sheets.', dcTersimpan:'✓ Guardado', dcBaruSaja:'ahora mismo', dcMntLalu:'hace {n} min', dcJamLalu:'hace {n} h', dcHariLalu:'hace {n} días',
    upgradePacketLabel:'Mejorar plan', upgradePacketDesc:'Acceso ilimitado y más rápido',
    trialBadgeExpired:'⚠ Cuota agotada · Mejorar', trialBadgePct:'{pct}% restante', trialBannerText:'{pct}% de cuota restante.',
    trialQuotaTitle:'📊 Estado de tu cuota', trialQuotaSub:'Todavía te queda {pct}% de cuota.', trialQuotaItem1:'💬 Aún puedes enviar mensajes y hacer preguntas.', trialQuotaItem2:'⚡ Mejora para cuota ilimitada sin restricciones.', trialQuotaCta:'Entendido',
    convFallbackTitle:'Conversación', trialExpiredErrMsg:'Tu período de prueba gratuita ha terminado.', continuationInstr:'[SISTEMA: Respuesta cortada. Continúa desde: "...{snippet}"] Continúa tu respuesta.',
    userPreferences: 'Preferencias de usuario',
    scraperTitle:'Agente Web Scraper', scraperSubtitle:'Lee y analiza cualquier contenido web',
    scraperUrlLabel:'URL del sitio', scraperUrlPh:'https://example.com/...',
    scraperUrlError:'La URL debe comenzar con https:// o http://',
    scraperModeLabel:'Modo de análisis',
    scraperModeSum:'Resumir', scraperModeSumDesc:'Resumen completo',
    scraperModeExt:'Extraer', scraperModeExtDesc:'Datos estructurados',
    scraperModeAna:'Analizar', scraperModeAnaDesc:'Análisis profundo',
    scraperModeQa:'Preguntar', scraperModeQaDesc:'Preguntas y respuestas',
    scraperQaLabel:'Tu pregunta', scraperQaPh:'¿Qué quieres saber de este sitio?',
    scraperBtnRun:'Scrape y analizar', scraperBtnCancel:'Cancelar',
    scraperErrTitle:'Error al obtener contenido', scraperErrTips:'Asegúrate de que la URL sea accesible públicamente y no requiera inicio de sesión.',
    scraperStepsDone:'{n} pasos completados', scraperProcessing:'Procesando...',
    scraperResultLabel:'Resultado del análisis',
    scraperSendChat:'Enviar al chat', scraperCopy:'Copiar', scraperCopied:'¡Copiado!',
    scraperRetry:'Reintentar', scraperAiAnalyzing:'La IA está analizando...',
    scraperCancelled:'⏹ Cancelado',
    scraperWordCount:'{n} palabras', scraperLinkCount:'{n} enlaces', scraperImgCount:'{n} imágenes',
    sheetErrorSheets401:'No se puede acceder a Google Sheets (401). Abre Google Sheets → Compartir → cambia a "Cualquier persona con el enlace puede ver".',
    sheetErrorSheets403:'Acceso denegado (403). Asegúrate de que el acceso esté configurado como "Cualquier persona con el enlace", no como "Restringido".',
    sheetErrorSheets404:'No se encontró la hoja de cálculo (404). Verifica que el enlace sea correcto y que el archivo aún exista.',
    sheetErrorSheetsNet:'No se puede conectar a Google Sheets. Revisa tu conexión a internet e inténtalo de nuevo.',
    sheetErrorReadSize:'El archivo es demasiado grande. Máximo 10MB. Intenta eliminar hojas innecesarias o comprimir los datos.',
    sheetErrorReadFormat:'Formato de archivo no compatible. Por favor usa .xlsx, .xls o .csv.',
    fbTitle:'Form Builder AI', fbSubtitle:'Crea formularios dinámicos con IA o manualmente', fbModeInterview:'Entrevista IA', fbModeManual:'Manual', fbModeTemplate:'Plantilla', fbStartInterview:'Iniciar Entrevista', fbGenerating:'La IA está creando el formulario...', fbPreview:'Vista previa', fbEdit:'Editar', fbEmbed:'Insertar', fbShare:'Compartir', fbCopy:'Copiar', fbCopied:'¡Copiado!', fbSave:'Guardar Formulario', fbSaved:'Guardado', fbSaving:'Guardando...', fbAddField:'+ Agregar Campo', fbAddSection:'+ Agregar Sección', fbDeleteField:'Eliminar campo', fbDeleteSection:'Eliminar sección', fbRequired:'Obligatorio', fbFieldLabel:'Etiqueta del campo', fbFieldType:'Tipo', fbFieldPlaceholder:'Marcador', fbFieldHint:'Sugerencia (opcional)', fbOptions:'Opciones de respuesta', fbAddOption:'Agregar opción', fbSectionTitle:'Título de sección', fbSectionDesc:'Descripción', fbMinEntries:'Mín. entradas', fbMaxEntries:'Máx. entradas', fbSubmitLabel:'Texto del botón enviar', fbSuccessMsg:'Mensaje de éxito', fbFormTitle:'Título del formulario', fbFormDesc:'Descripción del formulario', fbStaticFields:'Campos Estáticos', fbDynSections:'Secciones Dinámicas', fbSendToChat:'Enviar al Chat', fbNewForm:'Nuevo Formulario', fbEmbedCode:'Código de Inserción', fbShareLink:'Enlace para Compartir', fbInterviewStep:'Pregunta', fbInterviewOf:'de', fbSkip:'Omitir', fbTemplates:'Elegir Plantilla',
  }},
  fr: { label: 'Français', flag: '🇫🇷', ui: {
    newChat:'Nouveau Chat', searchPlaceholder:'Rechercher...', noConversations:'Aucune conversation.\nCommencez un nouveau chat !', noResults:'Introuvable',
    suggestions: [
      '🏥|Santé|Je veux discuter de sujets de santé et de mode de vie sain',
      '💰|Finances|Aidez-moi à planifier mes finances personnelles et investissements',
      '📚|Éducation|Je veux apprendre et comprendre des sujets académiques en profondeur',
      '🌿|Environnement|Discuter des problèmes environnementaux et de la vie écologique',
      '📔|Journal|Aidez-moi à écrire un journal réflexif et de croissance personnelle',
      '💼|Carrière|Consultation de carrière, CV et développement professionnel',
      '🍳|Cuisine|Recommandations de recettes et conseils de cuisine quotidienne',
      '🧠|Psychologie|Discuter de la santé mentale et du développement personnel',
      ],
    model:'Modèle', systemPrompt:'Invite système', systemPromptPh:"Configurer l'assistant...", clearAll:'Tout effacer',
    deleteConfirm:'Cliquez à nouveau pour confirmer', today:"Aujourd'hui", yesterday:'Hier', days7:'7 derniers jours',
    thisMonth:'Ce mois', older:'Plus ancien', messages:'messages', savedAuto:'Sauvegarde auto',
    typeMessage:'Écrire un message...', enterSend:'Entrée pour envoyer', shiftNewline:'Shift+Entrée nouvelle ligne',
    webSearch:'Répondu depuis internet', admin:'Admin', theme:'Thème', font:'Police', language:'Langue',
    settings:'Paramètres', startChat:'Écrivez un message pour commencer.', orSelectOld:'Sélectionnez une ancienne conversation\nou commencez une conversation plus spécifique.',
    prompt:'Invite', completion:'Complétion', total:'Total',
    copy:'Copier', copied:'Copié !', listen:'Écouter', stop:'Arrêter', retry:'Réessayer', share:'Partager', shareSource:'Source',
    errorApi:"Service d'IA indisponible", errorNetwork:'Connexion perdue', errorRate:'Trop de requêtes', errorOther:'Problème temporaire',
    dismiss:'Fermer', errorTitle:'Erreur', profile:'Profil', logout:'Déconnexion', myAccount:'Mon compte',
    generatingImage:"Génération de l'image...", imagePromptLabel:'Prompt :', downloadImage:'⬇ Télécharger', imageError:"Échec de la génération. Réessayez.",
    viewFull:'🔍 Voir en plein', clickToZoom:'🔍 Cliquer pour agrandir',
    continueBtnLabel:'Continuer la réponse', continuingLabel:'En cours...', truncatedNotice:'Réponse coupée — cliquez pour continuer',
    upgradeTitle:'Quota épuisé', upgradeDesc:'Votre quota mensuel de tokens est épuisé.', upgradeBtn:'Mettre à niveau', upgradeDismiss:'Plus tard',
    quotaExceeded:'Votre quota de tokens est épuisé.',
    aiDisclaimer: "L'IA peut faire des erreurs. Vérifiez les informations importantes.",
    deleteTitle:'Supprimer le chat ?', deleteDesc:'sera supprimé de votre historique de conversations.', deleteConfirmBtn:'Supprimer', deleteCancelBtn:'Annuler',
    trialExpiredClose:'Fermer', trialExpiredViewHistory:"Voir l'historique uniquement",
    trialComingSoonTitle:"🚧 Bientôt disponible", trialComingSoonSub:"Notre système de paiement est en phase de développement final.", trialComingSoonItem1:"Intégration de la passerelle de paiement en test", trialComingSoonItem2:"Sécurité des transactions en cours de certification", trialComingSoonItem3:"Vous serez notifié par email dès que c'est prêt", trialComingSoonCta:"Compris, prévenez-moi plus tard", trialComingSoonFooter:"Vous pouvez toujours lire tout votre historique de chat.",
    groupPickerTitle:"Choisir l'Intelligence IA", groupFlashLabel:'Swift 3.1', groupFlashDesc:'Rapide et léger', groupSmartLabel:'Pro 4.2', groupSmartDesc:'Équilibré et fiable', groupDeepLabel:'Ultra 4.8', groupDeepDesc:'Analyse approfondie', groupEliteLabel:'Max 5.0', groupEliteDesc:'Meilleure capacité',
    viewProfile:'Voir le profil',
    sheetTitle:'Analyse de données', sheetBaris:'lignes', sheetKolom:'colonnes', sheetUploadTab:'📂 Télécharger Excel / CSV', sheetLinkTab:'🔗 Lien Google Sheets', sheetClickDrop:'Cliquez ou glissez-déposez le fichier', sheetFormats:'.xlsx · .xls · .csv · max 10 Mo', sheetSharingNote:'Assurez-vous que le partage Google Sheets est défini sur', sheetSharingLink:'Toute personne avec le lien peut voir', sheetLoadingFile:'Lecture du fichier…', sheetLoadingSheets:'Récupération de Google Sheets…', sheetErrorRead:'Échec de la lecture du fichier', sheetErrorSheets:'Échec de la récupération de Google Sheets', sheetErrorAnalyze:'Échec de analyse des données', sheetRawToggleHide:'Masquer', sheetRawToggleShow:'Voir', sheetRawLabel:'données brutes (échantillon {n} lignes)', sheetKuotaLabel:'Quota utilisé', sheetAiLabel:'🤖 AI Insights', sheetRegenerate:'Régénérer', sheetAnalyzing:'Analyse des données…', sheetAskPlaceholder:'Posez une question', sheetChangeFile:'Analyser un autre fichier', sheetTrendTitle:'Tendance des données', sheetExportExcel:'Excel', sheetExportPdf:'PDF',
    dcTitle:'Canevas de données', dcLembar:'feuilles', dcBaris:'lignes', dcKolom:'colonnes', dcAktif:'Actif', dcChat:'Chat', dcAktifTitle:'Déjà actif dans le chat', dcPakaiTitle:'Utiliser dans le chat', dcLagi:'+{n} de plus', dcBukaSheets:'Ouvrir Google Sheets', dcLoading:'Chargement…', dcRefresh:'Actualiser', dcGagal:'Échec du chargement', dcKosong:'Aucun canevas de données.', dcKosongSub:'Téléchargez Excel ou Google Sheets.', dcTersimpan:'✓ Enregistré', dcBaruSaja:"à l'instant", dcMntLalu:'il y a {n} min', dcJamLalu:'il y a {n} h', dcHariLalu:'il y a {n} j',
    upgradePacketLabel:'Améliorer le forfait', upgradePacketDesc:'Accès illimité et plus rapide',
    trialBadgeExpired:'⚠ Quota épuisé · Améliorer', trialBadgePct:'{pct}% restant', trialBannerText:'{pct}% du quota restant.',
    trialQuotaTitle:'📊 État de votre quota', trialQuotaSub:'Il vous reste encore {pct}% de quota.', trialQuotaItem1:'💬 Vous pouvez encore envoyer des messages.', trialQuotaItem2:'⚡ Améliorez pour un quota illimité sans restrictions.', trialQuotaCta:'Compris',
    convFallbackTitle:'Conversation', trialExpiredErrMsg:"Votre période d'essai gratuit est terminée.", continuationInstr:'[SYSTÈME: Réponse coupée. Continuez depuis: "...{snippet}"] Continuez votre réponse.',
    userPreferences: 'Préférences utilisateur',
    scraperTitle:'Agent Web Scraper', scraperSubtitle:'Lire et analyser tout contenu web',
    scraperUrlLabel:'URL du site', scraperUrlPh:'https://example.com/...',
    scraperUrlError:"L'URL doit commencer par https:// ou http://",
    scraperModeLabel:"Mode d'analyse",
    scraperModeSum:'Résumer', scraperModeSumDesc:'Résumé complet',
    scraperModeExt:'Extraire', scraperModeExtDesc:'Données structurées',
    scraperModeAna:'Analyser', scraperModeAnaDesc:'Analyse approfondie',
    scraperModeQa:'Question', scraperModeQaDesc:'Questions-réponses',
    scraperQaLabel:'Votre question', scraperQaPh:'Que voulez-vous savoir sur ce site ?',
    scraperBtnRun:'Scraper et analyser', scraperBtnCancel:'Annuler',
    scraperErrTitle:'Échec de récupération', scraperErrTips:"Assurez-vous que l'URL est accessible publiquement et ne nécessite pas de connexion.",
    scraperStepsDone:'{n} étapes terminées', scraperProcessing:'Traitement en cours...',
    scraperResultLabel:"Résultat de l'analyse",
    scraperSendChat:'Envoyer au chat', scraperCopy:'Copier', scraperCopied:'Copié !',
    scraperRetry:'Réessayer', scraperAiAnalyzing:"L'IA analyse...",
    scraperCancelled:'⏹ Annulé',
    scraperWordCount:'{n} mots', scraperLinkCount:'{n} liens', scraperImgCount:'{n} images',
    sheetErrorSheets401:"Impossible d'accéder à Google Sheets (401). Ouvrez Google Sheets → Partager → définissez sur \"Toute personne avec le lien peut afficher\".",
    sheetErrorSheets403:"Accès refusé (403). Assurez-vous que le partage est défini sur \"Toute personne avec le lien\", et non sur \"Restreint\".",
    sheetErrorSheets404:"Feuille de calcul introuvable (404). Vérifiez que le lien est correct et que le fichier existe toujours.",
    sheetErrorSheetsNet:"Impossible de se connecter à Google Sheets. Vérifiez votre connexion Internet et réessayez.",
    sheetErrorReadSize:"Le fichier est trop volumineux. Maximum 10 Mo. Essayez de supprimer les feuilles inutiles ou de compresser les données.",
    sheetErrorReadFormat:"Veuillez utiliser .xlsx, .xls ou .csv.",
    fbTitle:'Form Builder AI', fbSubtitle:'Créez des formulaires dynamiques avec IA ou manuellement', fbModeInterview:'Entretien IA', fbModeManual:'Manuel', fbModeTemplate:'Modèle', fbStartInterview:"Démarrer l'entretien", fbGenerating:"L'IA crée le formulaire...", fbPreview:'Aperçu', fbEdit:'Modifier', fbEmbed:'Intégrer', fbShare:'Partager', fbCopy:'Copier', fbCopied:'Copié !', fbSave:'Enregistrer', fbSaved:'Enregistré', fbSaving:'Enregistrement...', fbAddField:'+ Ajouter un champ', fbAddSection:'+ Ajouter une section', fbDeleteField:'Supprimer le champ', fbDeleteSection:'Supprimer la section', fbRequired:'Obligatoire', fbFieldLabel:'Libellé du champ', fbFieldType:'Type', fbFieldPlaceholder:'Texte indicatif', fbFieldHint:'Indice (optionnel)', fbOptions:'Options de réponse', fbAddOption:'Ajouter une option', fbSectionTitle:'Titre de la section', fbSectionDesc:'Description', fbMinEntries:'Min. entrées', fbMaxEntries:'Max. entrées', fbSubmitLabel:'Texte du bouton envoyer', fbSuccessMsg:'Message de succès', fbFormTitle:'Titre du formulaire', fbFormDesc:'Description du formulaire', fbStaticFields:'Champs Statiques', fbDynSections:'Sections Dynamiques', fbSendToChat:'Envoyer au Chat', fbNewForm:'Nouveau Formulaire', fbEmbedCode:"Code d'intégration", fbShareLink:'Lien de partage', fbInterviewStep:'Question', fbInterviewOf:'sur', fbSkip:'Passer', fbTemplates:'Choisir un modèle',
  }},
}

// =======
// HELPER: konversi model ID → grup
// =======
function getModelTier_client(modelId: string): ModelGroupKey {
  const id = modelId.toLowerCase()
  if (id.includes('flash') || id.includes('1b') || id.includes('3b') ||
      id.includes('7b')    || id.includes('8b') || id.includes('9b')) return 'flash'
  if (id.includes('70b')   || id.includes('72b') || id.includes('scout') ||
      id.includes('27b')   || id.includes('32b')) return 'smart'
  if (id.includes('maverick') || id.includes('r1')  || id.includes('120b') ||
      id.includes('v3')        || id.includes('gemini')) return 'deep'
  if (id.includes('235b') || id.includes('671b') || id.includes('kimi') ||
      id.includes('elite') || id.includes('coder')) return 'elite'
  if (id === 'flash' || id === 'smart' || id === 'deep' || id === 'elite') return id as ModelGroupKey
  return 'deep'
}

// =======
// DETEKSI BAHASA
// =======
function detectLangInstruction(text: string): string {
  const t = text.toLowerCase()
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text) || (/[\u4E00-\u9FAF]/.test(text) && /[はがをにもでのへ]/.test(text))) return 'IMPORTANT: Always respond in Japanese (日本語) only.'
  if (/[\uAC00-\uD7AF]/.test(text)) return '중요: 항상 한국어로만 답변하세요.'
  if (/[\u4E00-\u9FFF]/.test(text) && !/[はがをにもで\u3040-\u309F\u30A0-\u30FF]/.test(text)) return '重要：始终只用中文回答，不使用其他语言。'
  if (/[\u0600-\u06FF]/.test(text)) return 'مهم: أجب دائماً باللغة العربية فقط.'
  if (/[\u0400-\u04FF]/.test(text)) return 'ВАЖНО: Всегда отвечай только на русском языке.'
  if (/[\u0900-\u097F]/.test(text)) return 'महत्वपूर्ण: हमेशा केवल हिंदी में उत्तर दें।'
  if (/\b(yang|adalah|dengan|untuk|atau|saya|aku|kamu|anda|bagaimana|apa|kenapa|mengapa|bisa|tidak|ya|dan|di|ke|dari|ini|itu)\b/.test(t)) return 'PENTING: Jawab SELALU dalam Bahasa Indonesia. Jangan gunakan bahasa lain.'
  if (/\b(el|la|los|las|una?|que|con|para|por|es|son|está|estoy|hola|gracias|como|cuando)\b/.test(t)) return 'IMPORTANTE: Responde SIEMPRE solo en español.'
  if (/\b(le|la|les|un|une|des|avec|pour|que|est|sont|je|tu|il|nous|vous|bonjour|merci)\b/.test(t)) return "IMPORTANT: Répondez TOUJOURS uniquement en français."
  if (/\b(der|die|das|ein|eine|und|für|mit|oder|ich|du|er|wir|ist|sind|hallo|danke)\b/.test(t)) return 'WICHTIG: Antworte IMMER nur auf Deutsch.'
  if (/\b(o|a|os|as|um|uma|com|para|que|é|são|eu|você|obrigado|olá|como)\b/.test(t)) return 'IMPORTANTE: Responda SEMPRE apenas em português.'
  if (/\b(il|la|gli|le|un|una|con|per|che|è|sono|io|tu|ciao|grazie)\b/.test(t)) return 'IMPORTANTE: Rispondi SEMPRE solo in italiano.'
  return 'IMPORTANT: Always respond in English only. Do not use any other language.'
}

// =======
// SANITIZE TEXT — bersihkan karakter Unicode tersembunyi sebelum dikirim ke AI
// =======
function sanitizeText(str: string): string {
  if (!str) return ''
  return str
    .normalize('NFC')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u200B-\u200F]/g, '')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/[\u202A-\u202E]/g, '')
    .replace(/[\u2060-\u2064\u2066-\u206F]/g, '')
    .replace(/\uFEFF/g, '')
    .replace(/[\uE000-\uF8FF]/g, '')
    .replace(/[\u2018\u2019\u02BC\u0060\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u00AB\u00BB\u2039\u203A]/g, '"')
    .replace(/[\u00A0\u202F\u2007\u2008\u2009\u200A\u3000\u1680]/g, ' ')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\S\n]+/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .join('\n')
    .trim()
}

// =======
// UTILS
// =======
function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const arr = new Uint8Array(12)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => chars[b % chars.length]).join('')
}

function formatMsgTime(timestamp: number): string {
  if (!timestamp) return ''
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
}

function renderMd(text: string): string {
  if (!text) return ''
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    // Tambahkan ini di renderMd(), sebelum .replace(/\n/g, '<br>'):
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" style="color:var(--accent);word-break:break-all;">$1</a>')
    .replace(/\n/g, '<br>')
}

function getInitials(name?: string | null): string {
  if (!name) return 'U'
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)
}

// =======
// UserAvatar
// =======
function UserAvatar({ image, name, size = 30, fontSize = 13, borderRadius = 9 }: {
  image?: string | null; name?: string | null; size?: number; fontSize?: number; borderRadius?: number
}) {
  const [imgError, setImgError] = useState(false)
  if (image && !imgError) {
    return <img src={image} alt={name ?? 'User'} onError={() => setImgError(true)}
      style={{ width: size, height: size, borderRadius, objectFit: 'cover', flexShrink: 0, display: 'block' }}/>
  }
  return (
    <div style={{ width: size, height: size, borderRadius, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--send-color)', fontSize, fontWeight: 700, flexShrink: 0 }}>
      {getInitials(name)}
    </div>
  )
}

// =======
// PaymentComingSoonPopup
// =======
function PaymentComingSoonPopup({
  onClose,
  t,
}: {
  onClose: () => void
  t: UIStrings
}) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])
  useEffect(() => {
    if (!mounted) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [mounted])

  if (!mounted) return null

  return createPortal(
    <>
      <style>{`
        @keyframes payPopInChat {
          from { opacity:0; transform:translateY(24px) scale(0.97); }
          to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes pulseRingChat {
          0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent); }
          70%  { box-shadow: 0 0 0 14px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        @keyframes overlayInChat { from{opacity:0} to{opacity:1} }
      `}</style>
      <div
        onClick={e => e.target === e.currentTarget && onClose()}
        style={{
          position:'fixed', inset:0, zIndex:99999,
          background:'rgba(0,0,0,0.75)',
          backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)',
          display:'flex', alignItems:'center', justifyContent:'center',
          padding:16, animation:'overlayInChat 0.2s ease both',
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background:'var(--surface)',
            border:'1px solid var(--border)',
            borderRadius:24, width:'100%', maxWidth:420,
            padding:'36px 32px 28px',
            boxShadow:'0 40px 100px rgba(0,0,0,0.8)',
            position:'relative',
            animation:'payPopInChat 0.3s cubic-bezier(0.34,1.4,0.64,1) both',
          }}
        >
          <button
            onClick={onClose}
            style={{
              position:'absolute', top:16, right:16,
              width:30, height:30, borderRadius:8,
              background:'var(--surface2)',
              border:'1px solid var(--border)',
              color:'var(--muted)', cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              outline:'none', transition:'all 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
          >
            <X size={14}/>
          </button>

          <div style={{ display:'flex', justifyContent:'center', marginBottom:24 }}>
            <div style={{
              width:72, height:72, borderRadius:'50%',
              background:'color-mix(in srgb, var(--accent) 15%, transparent)',
              border:'2px solid color-mix(in srgb, var(--accent) 40%, transparent)',
              display:'flex', alignItems:'center', justifyContent:'center',
              animation:'pulseRingChat 2s ease-out infinite',
            }}>
              <Clock size={32} color="var(--accent)"/>
            </div>
          </div>

          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{
              fontFamily:"'Syne', sans-serif", fontWeight:900,
              fontSize:'1.2rem', color:'var(--text)',
              marginBottom:12, letterSpacing:'-0.02em',
            }}>
              {t.trialComingSoonTitle}
            </div>
            <p style={{ fontSize:'0.82rem', color:'var(--muted)', lineHeight:1.75, margin:0 }}>
              {t.trialComingSoonSub}
            </p>
          </div>

          <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:24 }}>
            {[
              { icon:'⚡', text: t.trialComingSoonItem1 },
              { icon:'🔒', text: t.trialComingSoonItem2 },
              { icon:'📧', text: t.trialComingSoonItem3 },
            ].map((item, i) => (
              <div key={i} style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'10px 14px',
                background:'var(--surface2)',
                border:'1px solid var(--border)',
                borderRadius:10,
              }}>
                <span style={{ fontSize:'1rem', flexShrink:0 }}>{item.icon}</span>
                <span style={{ fontSize:'0.75rem', color:'var(--muted)', lineHeight:1.5 }}>{item.text}</span>
              </div>
            ))}
          </div>

          <button
            onClick={onClose}
            style={{
              width:'100%', padding:'13px', borderRadius:14,
              border:'1.5px solid color-mix(in srgb, var(--accent) 50%, transparent)',
              background:'transparent', color:'var(--accent)',
              fontFamily:"'Syne', sans-serif", fontWeight:700,
              fontSize:'0.85rem', cursor:'pointer',
              transition:'all 0.2s', outline:'none',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, var(--accent) 12%, transparent)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
          >
            {t.trialComingSoonCta}
          </button>

          <p style={{
            textAlign:'center', fontSize:'0.65rem',
            color:'var(--muted)', marginTop:14, lineHeight:1.6, opacity:0.7,
          }}>
            {t.trialComingSoonFooter}
          </p>
        </div>
      </div>
    </>,
    document.body
  )
}

// =======
// QuotaResetPopup
// =======
function QuotaResetPopup({
  onClose,
  t,
  resetAt,
}: {
  onClose:  () => void
  t:        UIStrings
  resetAt?: string | null   // ISO string dari API — field resetAt di /api/user/trial
}) {
  const [mounted, setMounted] = useState(false)
  const [now, setNow]         = useState(Date.now())

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Pakai resetAt dari API jika tersedia, fallback ke 6 jam dari sekarang
  const resetTime = useRef(
    resetAt ? new Date(resetAt).getTime() : Date.now() + 6 * 60 * 60 * 1000
  )

  const diffMs      = Math.max(0, resetTime.current - now)
  const diffHours   = Math.floor(diffMs / (1000 * 60 * 60))
  const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60))
  const diffSeconds = Math.floor((diffMs % (1000 * 60)) / 1000)
  const countdown   = `${String(diffHours).padStart(2,'0')}:${String(diffMinutes).padStart(2,'0')}:${String(diffSeconds).padStart(2,'0')}`
  const isReset     = diffMs <= 0

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  if (!mounted) return null

  return createPortal(
    <>
      <style>{`
        @keyframes quotaPopIn {
          from { opacity:0; transform:translateY(24px) scale(0.97); }
          to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes quotaOverlayIn { from{opacity:0} to{opacity:1} }
        @keyframes quotaRing {
          0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
          70%  { box-shadow: 0 0 0 14px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
        @keyframes countdownPulse {
          0%,100% { opacity:1; }
          50%     { opacity:0.6; }
        }
      `}</style>
      <div
        onClick={e => e.target === e.currentTarget && onClose()}
        style={{
          position:'fixed', inset:0, zIndex:99999,
          background:'rgba(0,0,0,0.78)',
          backdropFilter:'blur(12px)', WebkitBackdropFilter:'blur(12px)',
          display:'flex', alignItems:'center', justifyContent:'center',
          padding:16, animation:'quotaOverlayIn 0.2s ease both',
        }}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background:'var(--surface)',
            border:'1px solid rgba(239,68,68,0.3)',
            borderRadius:24, width:'100%', maxWidth:400,
            padding:'36px 28px 28px',
            boxShadow:'0 40px 100px rgba(0,0,0,0.8)',
            position:'relative',
            animation:'quotaPopIn 0.3s cubic-bezier(0.34,1.4,0.64,1) both',
          }}
        >
          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position:'absolute', top:16, right:16,
              width:30, height:30, borderRadius:8,
              background:'var(--surface2)',
              border:'1px solid var(--border)',
              color:'var(--muted)', cursor:'pointer',
              display:'flex', alignItems:'center', justifyContent:'center',
              outline:'none', transition:'all 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor='#ef4444'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor='var(--border)'}
          >
            <X size={14}/>
          </button>

          {/* Icon */}
          <div style={{ display:'flex', justifyContent:'center', marginBottom:20 }}>
            <div style={{
              width:68, height:68, borderRadius:'50%',
              background:'rgba(239,68,68,0.1)',
              border:'2px solid rgba(239,68,68,0.35)',
              display:'flex', alignItems:'center', justifyContent:'center',
              animation:'quotaRing 2s ease-out infinite',
            }}>
              {isReset
                ? <Check size={30} color="#22c55e"/>
                : <Zap size={30} color="#ef4444"/>
              }
            </div>
          </div>

          {/* Title */}
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{
              fontFamily:"'Syne', sans-serif", fontWeight:900,
              fontSize:'1.15rem',
              color: isReset ? '#22c55e' : 'var(--text)',
              marginBottom:8, letterSpacing:'-0.02em',
            }}>
              {isReset ? '✅ Kuota Telah Direset!' : '⚡ Kuota Token Habis'}
            </div>
            <p style={{ fontSize:'0.8rem', color:'var(--muted)', lineHeight:1.75, margin:0 }}>
              {isReset
                ? 'Kuota token kamu sudah direset. Kamu bisa melanjutkan percakapan sekarang.'
                : 'Kuota token kamu telah habis. Kuota akan direset otomatis dalam:'
              }
            </p>
          </div>

          {/* Countdown */}
          {!isReset && (
            <div style={{
              display:'flex', flexDirection:'column', alignItems:'center',
              gap:6, marginBottom:20,
            }}>
              <div style={{
                fontFamily:'monospace', fontSize:'2.4rem', fontWeight:900,
                color:'#ef4444', letterSpacing:'0.08em',
                animation:'countdownPulse 1s ease-in-out infinite',
                background:'rgba(239,68,68,0.08)',
                border:'1px solid rgba(239,68,68,0.2)',
                borderRadius:14, padding:'10px 28px',
              }}>
                {countdown}
              </div>
              <span style={{ fontSize:'0.62rem', color:'var(--muted)', opacity:0.6, letterSpacing:'0.06em', textTransform:'uppercase' }}>
                jam · menit · detik
              </span>
            </div>
          )}

          {/* Info items */}
          <div style={{ display:'flex', flexDirection:'column', gap:7, marginBottom:22 }}>
            {[
              { icon:'🔄', text:'Kuota direset otomatis setiap 6 jam sekali' },
              { icon:'💬', text:'Riwayat obrolan tetap tersimpan selama menunggu' },
              { icon:'⚡', text:'Upgrade paket untuk kuota unlimited tanpa batas' },
            ].map((item, i) => (
              <div key={i} style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'9px 13px',
                background:'var(--surface2)',
                border:'1px solid var(--border)',
                borderRadius:10,
              }}>
                <span style={{ fontSize:'0.9rem', flexShrink:0 }}>{item.icon}</span>
                <span style={{ fontSize:'0.73rem', color:'var(--muted)', lineHeight:1.5 }}>{item.text}</span>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {isReset ? (
              <button
                onClick={onClose}
                style={{
                  width:'100%', padding:'12px',
                  borderRadius:13, border:'none',
                  background:'#22c55e', color:'white',
                  fontFamily:"'Syne', sans-serif", fontWeight:700,
                  fontSize:'0.85rem', cursor:'pointer',
                  transition:'all 0.2s', outline:'none',
                }}
                onMouseEnter={e => (e.currentTarget as HTMLElement).style.opacity='0.88'}
                onMouseLeave={e => (e.currentTarget as HTMLElement).style.opacity='1'}
              >
                Lanjutkan Obrolan
              </button>
            ) : (
              <>
                <button
                  onClick={onClose}
                  style={{
                    width:'100%', padding:'12px',
                    borderRadius:13,
                    border:'1.5px solid rgba(239,68,68,0.4)',
                    background:'transparent', color:'#ef4444',
                    fontFamily:"'Syne', sans-serif", fontWeight:700,
                    fontSize:'0.85rem', cursor:'pointer',
                    transition:'all 0.2s', outline:'none',
                  }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background='rgba(239,68,68,0.08)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background='transparent'}
                >
                  Mengerti, Tutup
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}

// =======
// GroupPicker
// =======
function GroupPicker({ value, onChange, disabled, variant = 'desktop', t, showUpgradeBadge = false, onUpgradeClick }: {
  value: ModelGroupKey; onChange: (group: ModelGroupKey) => void
  disabled?: boolean; variant?: 'desktop' | 'mobile'; t: UIStrings
  showUpgradeBadge?: boolean
  onUpgradeClick?: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const GROUP_OPTIONS = [
    { key: 'flash' as ModelGroupKey, label: t.groupFlashLabel, desc: t.groupFlashDesc, Icon: Zap,    color: '#f59e0b' },
    { key: 'smart' as ModelGroupKey, label: t.groupSmartLabel, desc: t.groupSmartDesc, Icon: Brain,  color: '#3b82f6' },
    { key: 'deep'  as ModelGroupKey, label: t.groupDeepLabel,  desc: t.groupDeepDesc,  Icon: Search, color: '#8b5cf6' },
    { key: 'elite' as ModelGroupKey, label: t.groupEliteLabel, desc: t.groupEliteDesc, Icon: Crown,  color: '#f97316' },
  ]
  const current = GROUP_OPTIONS.find(g => g.key === value) ?? GROUP_OPTIONS[0]!

  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    if (open) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const panelStyle: React.CSSProperties = {
    position:'absolute', bottom:'calc(100% + 8px)', left:0,
    minWidth: variant==='mobile' ? '100%' : 260,
    background:'var(--surface)', border:'1px solid var(--border)', borderRadius:14, padding:6,
    boxShadow:'0 -16px 48px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.04)',
    zIndex:999, display:'flex', flexDirection:'column', gap:3,
  }

  const UpgradeBadge = () => showUpgradeBadge ? (
    <span
      onClick={e => { e.stopPropagation(); onUpgradeClick?.() }}
      style={{ fontSize:'0.52rem', fontWeight:700, background:'linear-gradient(135deg, #f97316, #f59e0b)', color:'#fff', padding:'2px 7px', borderRadius:20, letterSpacing:'0.06em', textTransform:'uppercase', cursor:'pointer', flexShrink:0, whiteSpace:'nowrap' }}
    >
      Upgrade
    </span>
  ) : null

  if (variant === 'mobile') {
    return (
      <div ref={ref} style={{ position:'relative', width:'100%' }}>
        <button onClick={() => !disabled && setOpen(o => !o)} style={{ width:'100%', display:'flex', alignItems:'center', gap:8, background:open?'var(--surface)':'var(--surface2)', border:`1px solid ${open?'var(--accent)':'var(--border)'}`, borderRadius:10, padding:'8px 12px', cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.5:1, transition:'all 0.2s', outline:'none' }}>
          <current.Icon size={15} color={current.color} style={{ flexShrink:0 }}/>
          <span style={{ fontSize:'0.76rem', fontWeight:700, color:'var(--text)', fontFamily:'inherit', flex:1, textAlign:'left' }}>{current.label}</span>
          {showUpgradeBadge && <UpgradeBadge/>}
          <ChevronDown size={11} color="var(--muted)" style={{ flexShrink:0, transform:open?'rotate(180deg)':'rotate(0deg)', transition:'transform 0.2s' }}/>
        </button>
        {open && (
          <div style={panelStyle}>
            <div style={{ fontSize:'0.54rem', letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--muted)', padding:'4px 10px 6px', opacity:0.5, borderBottom:'1px solid var(--border)', marginBottom:2 }}>{t.groupPickerTitle}</div>
            {showUpgradeBadge && (
              <button onClick={() => { onUpgradeClick?.(); setOpen(false) }}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 10px', borderRadius:9, background:'linear-gradient(135deg, rgba(249,115,22,0.08), rgba(245,158,11,0.08))', border:'1px solid rgba(249,115,22,0.25)', cursor:'pointer', outline:'none', width:'100%', textAlign:'left', marginBottom:4 }}>
                <div style={{ width:32, height:32, borderRadius:9, background:'linear-gradient(135deg, #f97316, #f59e0b)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <Crown size={15} color="white"/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:'0.78rem', fontWeight:700, color:'#f97316' }}>{t.upgradePacketLabel}</div>
                  <div style={{ fontSize:'0.62rem', color:'var(--muted)', opacity:0.8 }}>{t.upgradePacketDesc}</div>
                </div>
                <ArrowRight size={13} color="#f97316"/>
              </button>
            )}
            {GROUP_OPTIONS.map(g => {
              const active = g.key === value
              return (
                <button key={g.key} onClick={() => { onChange(g.key); setOpen(false) }} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 10px', borderRadius:9, background:active?'var(--surface2)':'transparent', border:active?`1px solid ${g.color}50`:'1px solid transparent', cursor:'pointer', outline:'none', transition:'all 0.12s', width:'100%', textAlign:'left' }}>
                  <div style={{ width:36, height:36, borderRadius:10, background:active?`${g.color}20`:'var(--surface2)', border:`1px solid ${active?g.color+'60':'var(--border)'}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    <g.Icon size={18} color={active?g.color:'var(--muted)'}/>
                  </div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:'0.8rem', fontWeight:active?700:500, color:active?'var(--text)':'var(--muted)' }}>{g.label}</div>
                    <div style={{ fontSize:'0.64rem', color:'var(--muted)', opacity:0.75 }}>{g.desc}</div>
                  </div>
                  {active && <div style={{ width:16, height:16, borderRadius:'50%', background:g.color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><Check size={9} color="white"/></div>}
                </button>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  return (
    <div ref={ref} style={{ position:'relative', flexShrink:0, alignSelf:'center' }}>
      <button onClick={() => !disabled && setOpen(o => !o)} style={{ display:'flex', alignItems:'center', gap:6, background:open?'var(--surface)':'var(--surface2)', border:`1px solid ${open?'var(--accent)':'var(--border)'}`, borderRadius:8, padding:'5px 9px', cursor:disabled?'not-allowed':'pointer', opacity:disabled?0.5:1, transition:'all 0.18s', outline:'none', marginBottom:2 }}>
        <current.Icon size={13} color={current.color} style={{ flexShrink:0 }}/>
        <span style={{ fontSize:'0.7rem', fontWeight:700, color:open?'var(--text)':'var(--muted)', fontFamily:'inherit' }}>{current.label}</span>
        {showUpgradeBadge && <UpgradeBadge/>}
        <ChevronDown size={9} color="var(--muted)" style={{ flexShrink:0, transform:open?'rotate(180deg)':'rotate(0deg)', transition:'transform 0.18s' }}/>
      </button>
      {open && (
        <div style={panelStyle}>
          <div style={{ fontSize:'0.54rem', letterSpacing:'0.12em', textTransform:'uppercase', color:'var(--muted)', padding:'4px 10px 6px', opacity:0.5 }}>{t.groupPickerTitle}</div>
          {showUpgradeBadge && (
            <button onClick={() => { onUpgradeClick?.(); setOpen(false) }}
              style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', borderRadius:8, background:'linear-gradient(135deg, rgba(249,115,22,0.08), rgba(245,158,11,0.08))', border:'1px solid rgba(249,115,22,0.25)', cursor:'pointer', outline:'none', width:'100%', textAlign:'left', marginBottom:4 }}
              onMouseEnter={e => (e.currentTarget as HTMLElement).style.background='linear-gradient(135deg, rgba(249,115,22,0.14), rgba(245,158,11,0.14))'}
              onMouseLeave={e => (e.currentTarget as HTMLElement).style.background='linear-gradient(135deg, rgba(249,115,22,0.08), rgba(245,158,11,0.08))'}>
              <div style={{ width:32, height:32, borderRadius:9, background:'linear-gradient(135deg, #f97316, #f59e0b)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                <Crown size={15} color="white"/>
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:'0.78rem', fontWeight:700, color:'#f97316' }}>{t.upgradePacketLabel}</div>
                <div style={{ fontSize:'0.62rem', color:'var(--muted)', opacity:0.8 }}>{t.upgradePacketDesc}</div>
              </div>
              <ArrowRight size={13} color="#f97316"/>
            </button>
          )}
          {GROUP_OPTIONS.map(g => {
            const active = g.key === value
            return (
              <button key={g.key} onClick={() => { onChange(g.key); setOpen(false) }} style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 10px', borderRadius:8, background:active?'var(--surface2)':'transparent', border:active?`1px solid ${g.color}50`:'1px solid transparent', cursor:'pointer', outline:'none', transition:'all 0.12s', width:'100%', textAlign:'left' }}
                onMouseEnter={e => { if(!active)(e.currentTarget as HTMLElement).style.background='var(--surface2)' }}
                onMouseLeave={e => { if(!active)(e.currentTarget as HTMLElement).style.background='transparent' }}>
                <div style={{ width:32, height:32, borderRadius:9, background:active?`${g.color}20`:'var(--surface2)', border:`1px solid ${active?g.color+'60':'var(--border)'}`, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                  <g.Icon size={15} color={active?g.color:'var(--muted)'}/>
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:'0.78rem', fontWeight:active?700:400, color:active?'var(--text)':'var(--muted)', fontFamily:'inherit' }}>{g.label}</div>
                  <div style={{ fontSize:'0.62rem', color:'var(--muted)', opacity:0.7 }}>{g.desc}</div>
                </div>
                {active && <div style={{ width:15, height:15, borderRadius:'50%', background:g.color, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}><Check size={8} color="white"/></div>}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// =======
// ArtifactPreviewPanel
// =======
interface ArtifactPreviewPanelProps {
  artifact: PastedArtifact | null
  onClose: () => void
  isMobile: boolean
}

function ArtifactPreviewPanel({ artifact, onClose, isMobile }: ArtifactPreviewPanelProps) {
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    if (artifact) {
      setMounted(true)
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)))
    } else {
      setVisible(false)
      const t = setTimeout(() => setMounted(false), 340)
      return () => clearTimeout(t)
    }
  }, [artifact])

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && artifact) onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [artifact, onClose])

  if (!mounted || !artifact) return null

  const LANG_COLORS: Record<string, string> = {
    json: '#f59e0b', html: '#e34c26', typescript: '#3178c6',
    python: '#3572A5', sql: '#e38c00', cpp: '#555599',
    code: 'var(--accent)', text: 'var(--muted)',
  }
  const langColor = LANG_COLORS[artifact.language] ?? 'var(--accent)'

  const desktopStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    right: 0,
    bottom: 0,
    width: 'min(480px, 50vw)',
    zIndex: 10500,
    background: 'var(--surface)',
    borderLeft: '1px solid var(--border)',
    display: 'flex',
    flexDirection: 'column',
    transform: visible ? 'translateX(0)' : 'translateX(100%)',
    transition: 'transform 0.32s cubic-bezier(0.4,0,0.2,1)',
    boxShadow: visible ? '-16px 0 48px rgba(0,0,0,0.35)' : 'none',
  }

  const mobileStyle: React.CSSProperties = {
    position: 'fixed',
    left: 0,
    right: 0,
    bottom: 0,
    height: 'min(75dvh, 600px)',
    zIndex: 10500,
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    borderRadius: '18px 18px 0 0',
    display: 'flex',
    flexDirection: 'column',
    transform: visible ? 'translateY(0)' : 'translateY(100%)',
    transition: 'transform 0.32s cubic-bezier(0.4,0,0.2,1)',
    boxShadow: visible ? '0 -12px 48px rgba(0,0,0,0.4)' : 'none',
  }

  const panelStyle = isMobile ? mobileStyle : desktopStyle

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 10499,
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
          opacity: visible ? 1 : 0,
          transition: 'opacity 0.32s ease',
          pointerEvents: visible ? 'auto' : 'none',
        }}
      />

      {/* Panel */}
      <div style={panelStyle}>
        {/* Mobile drag handle */}
        {isMobile && (
          <div style={{ display: 'flex', justifyContent: 'center', padding: '10px 0 4px', flexShrink: 0 }}>
            <div style={{ width: 36, height: 4, borderRadius: 2, background: 'var(--border)' }}/>
          </div>
        )}

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7,
            background: `${langColor}20`,
            border: `1px solid ${langColor}50`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <FileSpreadsheet size={13} color={langColor}/>
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {artifact.filename}
            </div>
            <div style={{ fontSize: '0.62rem', color: 'var(--muted)' }}>
              {artifact.language.toUpperCase()} · {formatFileSize(artifact.size)}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--surface2)', border: '1px solid var(--border)',
              color: 'var(--muted)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              outline: 'none', flexShrink: 0, transition: 'all 0.2s',
            }}
            onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'}
            onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'}
          >
            <X size={14}/>
          </button>
        </div>

        {/* Content — read only */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '0' }}>
          <pre style={{
            margin: 0,
            padding: '16px',
            fontFamily: "'DM Mono', 'JetBrains Mono', monospace",
            fontSize: '0.75rem',
            lineHeight: 1.7,
            color: 'var(--text)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            overflowWrap: 'anywhere',
            userSelect: 'text',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            pointerEvents: 'auto',
          }}>
            {artifact.content}
          </pre>
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          flexShrink: 0, gap: 8,
        }}>
          <span style={{ fontSize: '0.62rem', color: 'var(--muted)', opacity: 0.6, fontStyle: 'italic' }}>
            Read-only preview
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { try { navigator.clipboard.writeText(artifact.content) } catch { } }}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'transparent', border: '1px solid var(--border)',
                color: 'var(--muted)', fontFamily: 'inherit',
                fontSize: '0.7rem', padding: '5px 12px', borderRadius: 20,
                cursor: 'pointer', outline: 'none', transition: 'all 0.2s',
              }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--accent)'; (e.currentTarget as HTMLElement).style.color = 'var(--accent)' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--border)'; (e.currentTarget as HTMLElement).style.color = 'var(--muted)' }}
            >
              <Copy size={11}/> Copy
            </button>
            <button
              onClick={onClose}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: 'var(--surface2)', border: '1px solid var(--border)',
                color: 'var(--text)', fontFamily: 'inherit',
                fontSize: '0.7rem', padding: '5px 12px', borderRadius: 20,
                cursor: 'pointer', outline: 'none', transition: 'all 0.2s',
              }}
            >
              <X size={11}/> Close
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body
  )
}

// =======
// ChatInput
// =======
interface ChatInputProps {
  onSend: (text: string) => void; onStop: () => void
  isStreaming: boolean; isGenerating: boolean; disabled: boolean
  placeholder: string; placeholderBusy: string; hintEnter: string; hintShift: string
  externalSetInput: (setter: (val: string) => void) => void
  externalFocus: (focusFn: () => void) => void
  group: ModelGroupKey; onGroupChange: (group: ModelGroupKey) => void; t: UIStrings
  showUpgradeBadge?: boolean
  onUpgradeClick?: () => void
  onSheetAnalyzer?: () => void
  sheetAnalyzerActive?: boolean
  onDataCanvas?: () => void
  dataCanvasActive?: boolean
  onScraper?: () => void
  scraperActive?: boolean
  onFormBuilder?:    () => void
  formBuilderActive?:boolean
  onSlideGenerator?: () => void
  pastedArtifacts?: PastedArtifact[]
  onRemoveArtifact?: (id: string) => void
  onPreviewArtifact?: (artifact: PastedArtifact) => void
  onAddArtifact?: (artifact: PastedArtifact) => void
  artifactCounter?: number
  onLocationAgent?:    () => void
  locationAgentActive?:boolean
  imageAttachments?:   ImageAttachment[]
  onAddImage?:         (file: File) => void
  onRemoveImage?:      (id: string) => void
  isMobile?:           boolean
  onDriveExplorer?:    () => void
  driveExplorerActive?:boolean
}

const ChatInput = memo(function ChatInput({
  onSend, onStop, isStreaming, isGenerating, disabled,
  placeholder, placeholderBusy, hintEnter, hintShift,
  externalSetInput, externalFocus,
  group, onGroupChange, t,
  showUpgradeBadge, onUpgradeClick,
  onSheetAnalyzer, sheetAnalyzerActive,
  onDataCanvas, dataCanvasActive,
  onScraper, scraperActive,
  onFormBuilder, formBuilderActive,
  onSlideGenerator,
  pastedArtifacts, onRemoveArtifact, onPreviewArtifact, onAddArtifact, artifactCounter,
  onLocationAgent, locationAgentActive,
  imageAttachments, onAddImage, onRemoveImage, isMobile,
  onDriveExplorer, driveExplorerActive,
}: ChatInputProps) {
  const [text, setText] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textRef = useRef('')
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const [showAgentPanel, setShowAgentPanel] = useState(false)
  const artifactCounterRef = useRef(artifactCounter ?? 0)
  useEffect(() => { artifactCounterRef.current = artifactCounter ?? 0 }, [artifactCounter])

  const PASTE_THRESHOLD = 1  // karakter minimum untuk jadi artifact
  const MAX_ARTIFACT_SIZE = 50_000  // ~50 KB
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    try {
      const pasted = e.clipboardData?.getData('text') ?? ''
      if (!pasted) return
  
      // Jika terlalu besar, biarkan browser paste normal
      if (pasted.length > MAX_ARTIFACT_SIZE) return
  
      const lang = detectArtifactLanguage(pasted)
      if (lang === 'text') return
  
      e.preventDefault()
      const idx = (artifactCounterRef.current ?? 0) + (pastedArtifacts?.length ?? 0) + 1
      const artifact: PastedArtifact = {
        id:        generateId(),
        content:   pasted,
        language:  lang,
        filename:  generateArtifactFilename(lang, idx),
        size:      pasted.length,
        timestamp: Date.now(),
      }
      onAddArtifact?.(artifact)
    } catch { }
  }, [pastedArtifacts, onAddArtifact])

  useEffect(() => {
    externalSetInput((val: string) => {
      setText(val); textRef.current = val
      requestAnimationFrame(() => { const el = textareaRef.current; if (el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px' } })
    })
  }, [externalSetInput])

  useEffect(() => { externalFocus(() => { textareaRef.current?.focus() }) }, [externalFocus])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value; setText(val); textRef.current = val
    const el = e.target; el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }, [])

  const handleSend = useCallback(() => {
    const val = textRef.current.trim(); if (!val || disabled) return
    onSend(val); setText(''); textRef.current = ''
    const el = textareaRef.current; if (el) el.style.height = 'auto'
  }, [onSend, disabled])

  const handleKey = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  // Navigasi ke Form Builder — delegasikan ke ChatApp yang punya router
  const goToFormBuilder = useCallback(() => {
    setShowAgentPanel(false)
    onFormBuilder?.()
  }, [onFormBuilder])

  const anyAgentActive = sheetAnalyzerActive || dataCanvasActive || scraperActive

  const isEmpty = !text.trim()
  return (
    <div style={{ padding:'10px 16px 16px', borderTop:'1px solid var(--border)', flexShrink:0 }}>
      <div style={{ maxWidth:780, margin:'0 auto', width:'100%' }}>
        <div className="model-above-input" style={{ marginBottom:8 }}>
          <GroupPicker value={group} onChange={onGroupChange} disabled={disabled} variant="mobile" t={t} showUpgradeBadge={showUpgradeBadge} onUpgradeClick={onUpgradeClick}/>
        </div>
        <div onMouseEnter={() => setIsHovered(true)} onMouseLeave={() => setIsHovered(false)}
          style={{ display:'flex', gap:9, alignItems:'flex-end', background:isFocused?'var(--surface)':'var(--surface2)', border:isFocused?'1px solid var(--accent)':isHovered?'1px solid color-mix(in srgb, var(--accent) 50%, var(--border))':'1px solid var(--border)', borderRadius:13, padding:'9px 13px', transition:'border-color 0.22s ease, box-shadow 0.22s ease, background 0.22s ease', boxShadow:isFocused?'0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent), 0 4px 20px rgba(0,0,0,0.12)':isHovered?'0 0 0 2px color-mix(in srgb, var(--accent) 10%, transparent)':'none' }}>
          {/* Artifact chips */}
          {pastedArtifacts && pastedArtifacts.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: 8,
              marginBottom: 10,
              animation: 'artifactFadeIn 0.22s cubic-bezier(0.34,1.4,0.64,1)',
            }}>
              {pastedArtifacts.map(artifact => {
                const LANG_COLORS: Record<string, string> = {
                  json: '#f59e0b', html: '#e34c26', typescript: '#3178c6',
                  python: '#3572A5', sql: '#e38c00', cpp: '#555599',
                  code: 'var(--accent)', text: 'var(--muted)',
                }
                const c = LANG_COLORS[artifact.language] ?? 'var(--accent)'
                const previewLines = artifact.content
                  .split('\n')
                  .slice(0, 3)
                  .join('\n')
                
                // ← TAMBAH DI SINI
                const isLargeFile = artifact.size > 6000
                return (
                  <div
                    key={artifact.id}
                    onClick={() => onPreviewArtifact?.(artifact)}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      padding: '10px 12px',
                      background: `${c}10`,
                      border: `1px solid ${c}45`,
                      borderRadius: 12,
                      cursor: 'pointer',
                      transition: 'all 0.18s',
                      position: 'relative',
                      overflow: 'hidden',
                      animation: 'artifactFadeIn 0.22s cubic-bezier(0.34,1.4,0.64,1)',
                    }}
                    onMouseEnter={e => (e.currentTarget as HTMLElement).style.borderColor = c}
                    onMouseLeave={e => (e.currentTarget as HTMLElement).style.borderColor = `${c}45`}
                  >
                    {/* Header */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <FileSpreadsheet size={12} color={c} style={{ flexShrink: 0 }}/>
                      <span style={{
                        fontSize: '0.7rem', fontWeight: 700, color: c,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
                      }}>
                        {artifact.filename}
                      </span>
                      <button
                        onClick={e => { e.stopPropagation(); onRemoveArtifact?.(artifact.id) }}
                        style={{
                          width: 16, height: 16, borderRadius: '50%',
                          background: `${c}25`, border: 'none',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', color: c, flexShrink: 0, outline: 'none',
                        }}
                      >
                        <X size={9}/>
                      </button>
                    </div>
          
                    {/* Meta */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        fontSize: '0.58rem', fontWeight: 600,
                        background: `${c}20`, color: c,
                        padding: '1px 6px', borderRadius: 4,
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                      }}>
                        {artifact.language}
                      </span>
                      <span style={{ fontSize: '0.58rem', color: 'var(--muted)', opacity: 0.7 }}>
                        {formatFileSize(artifact.size)}
                      </span>
                    
                      {/* ← TAMBAH DI SINI */}
                      {isLargeFile && (
                        <span style={{
                          fontSize: '0.55rem', fontWeight: 700,
                          background: 'rgba(249,115,22,0.15)',
                          color: '#f97316',
                          padding: '1px 6px', borderRadius: 4,
                          textTransform: 'uppercase', letterSpacing: '0.04em',
                        }}>
                          Partial · {Math.ceil(artifact.size / 6000)} chunks
                        </span>
                      )}
                    </div>
          
                    {/* Code preview */}
                    <pre style={{
                      margin: 0,
                      fontSize: '0.6rem',
                      lineHeight: 1.5,
                      color: 'var(--muted)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      overflow: 'hidden',
                      maxHeight: 48,
                      opacity: 0.75,
                      fontFamily: "'DM Mono', monospace",
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      pointerEvents: 'none',
                    }}>
                      {previewLines}
                    </pre>
          
                    {/* Gradient overlay untuk fade bawah */}
                    <div style={{
                      position: 'absolute', bottom: 0, left: 0, right: 0, height: 24,
                      background: `linear-gradient(to bottom, transparent, ${c}15)`,
                      pointerEvents: 'none',
                    }}/>
                  </div>
                )
              })}
            </div>
          )}

          {/* Hidden file inputs */}
          <input
            id="img-upload-input"
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={e => {
              Array.from(e.target.files ?? []).slice(0, 3).forEach(f => onAddImage?.(f))
              e.target.value = ''
            }}
          />
          <input
            id="img-camera-input"
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) onAddImage?.(f)
              e.target.value = ''
            }}
          />
          
          {/* Image previews */}
          {imageAttachments && imageAttachments.length > 0 && (
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:8 }}>
              {imageAttachments.map(img => (
                <div key={img.id} style={{ position:'relative', width:56, height:56 }}>
                  <img
                    src={img.previewUrl}
                    alt={img.filename}
                    style={{ width:56, height:56, objectFit:'cover', borderRadius:9, border:'1px solid var(--border)' }}
                  />
                  <button
                    onClick={() => onRemoveImage?.(img.id)}
                    style={{ position:'absolute', top:-5, right:-5, width:16, height:16, borderRadius:'50%', background:'#ef4444', border:'none', color:'white', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', padding:0, outline:'none' }}>
                    <X size={9}/>
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="model-in-input">
            <GroupPicker value={group} onChange={onGroupChange} disabled={disabled} variant="desktop" t={t} showUpgradeBadge={showUpgradeBadge} onUpgradeClick={onUpgradeClick}/>
          </div>
          <textarea ref={textareaRef} value={text} onChange={handleChange} onKeyDown={handleKey} onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)} disabled={disabled} placeholder={isGenerating?placeholderBusy:placeholder} rows={1}
            style={{ flex:1, background:'transparent', border:'none', color:'var(--text)', fontFamily:'inherit', fontSize:'0.83rem', lineHeight:1.5, resize:'none', maxHeight:120, minHeight:24, outline:'none' }}/>
          {/* ── DESKTOP ONLY: tombol DA & Scraper individual ── */}
          <button className="desktop-agent-btn"
            onClick={() => {
              if (sheetAnalyzerActive || dataCanvasActive) { onSheetAnalyzer?.(); if (dataCanvasActive) onDataCanvas?.() }
              else { onSheetAnalyzer?.() }
            }}
            title="Analisis Data & Canvas"
            style={{ width:32, height:32, borderRadius:8,
              background:(sheetAnalyzerActive||dataCanvasActive)?'var(--accent)':'transparent',
              border:(sheetAnalyzerActive||dataCanvasActive)?'none':'1px solid var(--border)',
              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
              flexShrink:0, alignSelf:'flex-end', transition:'all 0.2s', outline:'none',
              opacity:disabled?0.4:1 }}>
            <FileSpreadsheet size={14} color={(sheetAnalyzerActive||dataCanvasActive)?'var(--send-color)':'var(--muted)'}/>
          </button>

          <button className="desktop-agent-btn" onClick={onScraper} title="Web Scraper Agent"
            style={{ width:32, height:32, borderRadius:8,
              background:scraperActive?'var(--accent)':'transparent',
              border:scraperActive?'none':'1px solid var(--border)',
              cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
              flexShrink:0, alignSelf:'flex-end', transition:'all 0.2s', outline:'none' }}>
            <Globe size={14} color={scraperActive?'var(--send-color)':'var(--muted)'}/>
          </button>

          <button className="desktop-agent-btn" onClick={onDriveExplorer} title="Google Drive Explorer"
            style={{ width:32, height:32, borderRadius:8,
            background:driveExplorerActive?'var(--accent)':'transparent',
            border:driveExplorerActive?'none':'1px solid var(--border)',
            cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center',
            flexShrink:0, alignSelf:'flex-end', transition:'all 0.2s', outline:'none' }}>
            <FolderOpen size={14} color={driveExplorerActive?'var(--send-color)':'var(--muted)'}/>
          </button>

          {/* Upload gambar — selalu tampil */}
          <button
            onClick={() => document.getElementById('img-upload-input')?.click()}
            disabled={disabled || (imageAttachments?.length ?? 0) >= 3}
            title="Lampirkan gambar"
            style={{
              width:32, height:32, borderRadius:8,
              background: 'transparent',
              border: '1px solid var(--border)',
              cursor: 'pointer', display:'flex', alignItems:'center',
              justifyContent:'center', flexShrink:0, alignSelf:'flex-end',
              transition:'all 0.2s', outline:'none',
              opacity: disabled || (imageAttachments?.length ?? 0) >= 3 ? 0.4 : 1,
            }}>
            {/* import ImageIcon from lucide — atau pakai FileImage */}
            <FileImage size={14} color="var(--muted)"/>
          </button>
          
          {/* Kamera — mobile only via CSS class */}
          <button
            className="camera-btn-mobile"
            onClick={() => document.getElementById('img-camera-input')?.click()}
            disabled={disabled || (imageAttachments?.length ?? 0) >= 3}
            title="Ambil foto"
            style={{
              width:32, height:32, borderRadius:8,
              background: 'transparent',
              border: '1px solid var(--border)',
              cursor: 'pointer', display:'none', alignItems:'center',
              justifyContent:'center', flexShrink:0, alignSelf:'flex-end',
              transition:'all 0.2s', outline:'none',
            }}>
            <Camera size={14} color="var(--muted)"/>
          </button>

          {/* ── MOBILE ONLY: tombol toggle AI Agents panel ── */}
          <button className="mobile-agent-toggle"
            onClick={() => setShowAgentPanel(o => !o)}
            title="AI Agents"
            style={{ width:32, height:32, borderRadius:8,
              background: anyAgentActive ? 'var(--accent)' : showAgentPanel ? 'color-mix(in srgb, var(--accent) 15%, var(--surface2))' : 'transparent',
              border: showAgentPanel || anyAgentActive ? 'none' : '1px solid var(--border)',
              cursor:'pointer', display:'none', alignItems:'center', justifyContent:'center',
              flexShrink:0, alignSelf:'flex-end', transition:'all 0.2s', outline:'none',
              opacity:disabled?0.4:1 }}>
            <Sparkles size={14} color={anyAgentActive ? 'var(--send-color)' : showAgentPanel ? 'var(--accent)' : 'var(--muted)'}/>
          </button>

          {/* Send / Stop */}
          {isStreaming ? (
            <button onClick={onStop} style={{ background:'#ef4444', border:'none', borderRadius:9, width:36, height:36, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, alignSelf:'flex-end', transition:'all 0.2s' }}><StopCircle size={15} color="white"/></button>
          ) : isGenerating ? (
            <button disabled style={{ background:'var(--surface)', border:'1px solid var(--border)', borderRadius:9, width:36, height:36, display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, alignSelf:'flex-end', opacity:0.6 }}><Loader2 size={15} color="var(--accent)" style={{ animation:'spin 1s linear infinite' }}/></button>
          ) : (
            <button onClick={handleSend} disabled={isEmpty} style={{ background:isEmpty?'var(--surface)':'var(--accent)', border:isEmpty?'1px solid var(--border)':'none', borderRadius:9, width:36, height:36, cursor:isEmpty?'not-allowed':'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, alignSelf:'flex-end', opacity:isEmpty?0.4:1, transition:'all 0.2s' }}><Send size={15} color={isEmpty?'var(--muted)':'var(--send-color)'}/></button>
          )}
        </div>

        <div style={{ marginTop:6, fontSize:'0.62rem', color:'var(--muted)', textAlign:'center', letterSpacing:'0.04em' }}>
          <span style={{ opacity:0.55, fontStyle:'italic' }}>{hintEnter}</span>
        </div>
      </div>

      {/* ── MOBILE AI AGENTS PANEL — hanya render saat showAgentPanel=true ── */}
      {showAgentPanel && typeof window !== 'undefined' && createPortal(
        <>
          {/* Overlay backdrop */}
          <div onClick={() => setShowAgentPanel(false)}
            style={{ position:'fixed', inset:0, zIndex:9990, background:'rgba(0,0,0,0.3)', backdropFilter:'blur(3px)', WebkitBackdropFilter:'blur(3px)' }}
          />
          {/* Panel slide-up */}
          <div
            style={{
              position:'fixed', left:0, right:0, bottom:0, zIndex:9991,
              background:'var(--surface)', borderTop:'1px solid var(--border)',
              borderRadius:'18px 18px 0 0',
              paddingBottom:'calc(env(safe-area-inset-bottom, 0px) + 12px)',
              boxShadow:'0 -8px 40px rgba(0,0,0,0.35)',
              display:'flex', flexDirection:'column',
              animation:'slideUpModal 0.25s cubic-bezier(0.34,1.2,0.64,1)',
            }}
          >
        {/* Drag handle */}
        <div style={{ display:'flex', justifyContent:'center', padding:'10px 0 6px' }}>
          <div style={{ width:36, height:4, borderRadius:2, background:'var(--border)' }}/>
        </div>

        {/* Panel header */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'2px 18px 12px' }}>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <Sparkles size={14} color="var(--accent)"/>
            <span style={{ fontSize:'0.78rem', fontWeight:700, color:'var(--text)', fontFamily:'Syne, sans-serif' }}>AI Agents</span>
          </div>
          <button onClick={() => setShowAgentPanel(false)}
            style={{ width:28, height:28, borderRadius:8, background:'var(--surface2)', border:'1px solid var(--border)', color:'var(--muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none' }}>
            <X size={13}/>
          </button>
        </div>

        {/* Agent list — tambah item baru di sini untuk fitur agent berikutnya */}
        <div style={{ display:'flex', flexDirection:'column', gap:0, padding:'0 12px 4px' }}>
          {[
            {
              icon: <FileSpreadsheet size={18} color="var(--accent)"/>,
              label: t.sheetTitle ?? 'Data Analysis',
              desc: 'Upload Excel / CSV / Google Sheets',
              active: !!(sheetAnalyzerActive || dataCanvasActive),
              onPress: () => { setShowAgentPanel(false); onSheetAnalyzer?.() },
            },
            {
              icon: <Globe size={18} color="#10b981"/>,
              label: t.scraperTitle ?? 'Web Scraper',
              desc: t.scraperSubtitle ?? 'Baca & analisis konten website',
              active: !!scraperActive,
              onPress: () => { setShowAgentPanel(false); onScraper?.() },
            },
            {
              icon: <Presentation size={18} color="#6366f1"/>,
              label: 'Slide Generator',
              desc: 'Buat presentasi otomatis dari prompt',
              active: false,
              onPress: () => { setShowAgentPanel(false); onSlideGenerator?.() },
            },
            {
              icon: <MapPin size={18} color="#f59e0b"/>,
              label: 'Location Agent',
              desc: 'Cari lokasi & tempat terdekat via HERE Maps',
              active: !!locationAgentActive,
              onPress: () => { setShowAgentPanel(false); onLocationAgent?.() },
            },
            {
              icon: <FolderOpen size={18} color="#4ade80"/>,
              label: 'Drive Explorer',
              desc: 'Baca & jelajahi folder Google Drive',
              active: !!driveExplorerActive,
              onPress: () => { setShowAgentPanel(false); onDriveExplorer?.() },
            },
            // {
            //   icon: <LayoutTemplate size={18} color="#a855f7"/>,
            //   label: t.fbTitle ?? 'Form Builder AI',
            //   desc: t.fbSubtitle ?? 'Buat form dinamis dengan AI',
            //   active: false,
            //   onPress: goToFormBuilder,
            // },
          ].map((item, i) => (
            <button key={i} onClick={item.onPress}
              style={{
                display:'flex', alignItems:'center', gap:14, padding:'12px 10px',
                borderRadius:12, marginBottom:4, width:'100%', textAlign:'left',
                background: item.active ? 'color-mix(in srgb, var(--accent) 8%, var(--surface2))' : 'transparent',
                border: item.active ? '1px solid color-mix(in srgb, var(--accent) 35%, var(--border))' : '1px solid transparent',
                cursor:'pointer', transition:'all 0.18s', outline:'none',
              }}>
              <div style={{ width:40, height:40, borderRadius:11, flexShrink:0, background:'var(--surface2)', border:'1px solid var(--border)', display:'flex', alignItems:'center', justifyContent:'center' }}>
                {item.icon}
              </div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:'0.82rem', fontWeight:600, color:'var(--text)', marginBottom:2 }}>{item.label}</div>
                <div style={{ fontSize:'0.68rem', color:'var(--muted)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.desc}</div>
              </div>
              {item.active
                ? <span style={{ fontSize:'0.58rem', fontWeight:700, background:'var(--accent)', color:'var(--send-color)', padding:'2px 8px', borderRadius:20, flexShrink:0 }}>Aktif</span>
                : <ChevronRight size={14} color="var(--muted)" style={{ flexShrink:0 }}/>
              }
            </button>
          ))}
        </div>

        <div style={{ padding:'4px 18px 0', textAlign:'center' }}>
          <span style={{ fontSize:'0.6rem', color:'var(--muted)', opacity:0.4, fontStyle:'italic' }}>
            Lebih banyak AI agent akan segera hadir ✦
          </span>
        </div>
          </div>
        </>,
        document.body
      )}
    </div>
  )
})

// =======
// UpgradeModal
// =======
function UpgradeModal({ t, onDismiss, onShowTrial }: {
  t: UIStrings
  onDismiss: () => void
  onShowTrial?: () => void
}) {
  return (
    <div onClick={onDismiss} style={{ position:'fixed',inset:0,zIndex:99998,background:'rgba(0,0,0,0.75)',backdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,animation:'fadeIn 0.25s ease-out' }}>
      <div onClick={e=>e.stopPropagation()} style={{ background:'var(--surface)',border:'1px solid var(--border)',borderRadius:20,padding:'32px 28px',maxWidth:420,width:'100%',boxShadow:'0 40px 120px rgba(0,0,0,0.6)',animation:'slideUpModal 0.3s cubic-bezier(0.34,1.56,0.64,1)',display:'flex',flexDirection:'column',alignItems:'center',gap:0 }}>
        <div style={{ width:64,height:64,borderRadius:18,background:'linear-gradient(135deg, #f97316, #f59e0b)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:20,boxShadow:'0 8px 32px rgba(249,115,22,0.4)' }}><Crown size={28} color="white"/></div>
        <div style={{ fontFamily:'Syne, sans-serif',fontWeight:800,fontSize:'1.3rem',color:'var(--text)',marginBottom:10,textAlign:'center' }}>{t.upgradeTitle}</div>
        <div style={{ fontSize:'0.82rem',color:'var(--muted)',lineHeight:1.7,textAlign:'center',marginBottom:28 }}>{t.upgradeDesc}</div>
        <div style={{ display:'flex',flexDirection:'column',gap:10,width:'100%',marginTop:4 }}>
          <button onClick={() => { onDismiss(); onShowTrial?.() }} style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:8,background:'var(--accent)',border:'none',borderRadius:12,color:'var(--send-color)',fontFamily:'inherit',fontSize:'0.88rem',fontWeight:700,padding:'13px 20px',cursor:'pointer',transition:'all 0.2s' }} onMouseEnter={e=>(e.currentTarget.style.opacity='0.88')} onMouseLeave={e=>(e.currentTarget.style.opacity='1')}>
            <Sparkles size={15}/> {t.upgradeBtn}
          </button>
          <button onClick={onDismiss} style={{ background:'transparent',border:'1px solid var(--border)',color:'var(--muted)',fontFamily:'inherit',fontSize:'0.78rem',padding:'10px 20px',borderRadius:12,cursor:'pointer',transition:'all 0.2s' }} onMouseEnter={e=>{ (e.currentTarget.style.borderColor='var(--accent)');(e.currentTarget.style.color='var(--text)') }} onMouseLeave={e=>{ (e.currentTarget.style.borderColor='var(--border)');(e.currentTarget.style.color='var(--muted)') }}>{t.upgradeDismiss}</button>
        </div>
      </div>
    </div>
  )
}

// =======
// SearchBadge
// =======
function SearchBadge({ label }: { label: string }) {
  return (
    <div style={{ display:'inline-flex',alignItems:'center',gap:'5px',backgroundColor:'rgba(16,185,129,0.12)',border:'1px solid rgba(16,185,129,0.35)',borderRadius:'999px',padding:'3px 10px',marginBottom:'6px',fontSize:'11.5px',fontWeight:500,color:'#10b981',userSelect:'none' as const,width:'fit-content' }}>
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
        <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
      </svg>
      {label}
    </div>
  )
}

// =======
// Sidebar
// =======
interface SidebarProps {
  t: UIStrings; conversations: Conversation[]; activeId: string | null
  searchQ: string; setSearchQ: (q: string) => void; filtered: Conversation[]
  grouped: ReturnType<typeof groupConversations>; GROUP_LABELS: string[]
  isSidebarLoading: boolean
  startNewChat: () => void; openConvo: (id: string) => void
  handleDelete: (id: string, e: React.MouseEvent) => void
  activeMessages: ChatMessage[]
}

const Sidebar = memo(function Sidebar({
  t, conversations, activeId, searchQ, setSearchQ, filtered, grouped, GROUP_LABELS,
  isSidebarLoading, startNewChat, openConvo, handleDelete, activeMessages,
}: SidebarProps) {
  return (
    <div style={{ display:'flex',flexDirection:'column',height:'100%',overflow:'hidden' }}>
      <div style={{ display:'flex',alignItems:'center',gap:10,padding:'4px 2px 16px',flexShrink:0 }}>
        <div style={{ width:32,height:32,background:'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}><Bot size={24} color="var(--accent)" strokeWidth={2.2}/></div>
        <span style={{ fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:'1rem',letterSpacing:'-0.02em' }}>
          {BRAND.shortName} <span style={{ color:'var(--accent)' }}>AI</span>
        </span>
      </div>

      <button onClick={startNewChat} style={{ width:'100%',display:'flex',alignItems:'center',justifyContent:'center',gap:7,background:'var(--accent)',border:'none',color:'var(--send-color)',fontFamily:'inherit',fontSize:'0.78rem',fontWeight:600,padding:'10px',borderRadius:10,cursor:'pointer',marginBottom:12,flexShrink:0,letterSpacing:'0.02em',transition:'opacity 0.2s' }} onMouseEnter={e=>(e.currentTarget.style.opacity='0.82')} onMouseLeave={e=>(e.currentTarget.style.opacity='1')}>
        <Plus size={15}/> {t.newChat}
      </button>

      <div style={{ display:'flex',alignItems:'center',gap:7,background:'var(--surface2)',border:'1px solid var(--border)',borderRadius:8,padding:'7px 10px',marginBottom:12,flexShrink:0,cursor:'text' }} onClick={e => { const inp = (e.currentTarget as HTMLElement).querySelector('input'); inp?.focus() }}>
        <Search size={12} color="var(--muted)" style={{ flexShrink:0,pointerEvents:'none' }}/>
        <input type="text" value={searchQ} onChange={e => setSearchQ(e.target.value)} placeholder={t.searchPlaceholder} style={{ flex:1,background:'transparent',border:'none',outline:'none',color:'var(--text)',fontFamily:'inherit',fontSize:'0.72rem',cursor:'text',pointerEvents:'auto',userSelect:'text',minWidth:0 }}/>
        {searchQ && <button onMouseDown={e => { e.preventDefault(); setSearchQ('') }} style={{ background:'none',border:'none',cursor:'pointer',color:'var(--muted)',display:'flex',padding:0,flexShrink:0 }}><X size={11}/></button>}
      </div>

      <div style={{ flex:1,overflowY:'auto',marginRight:-4,paddingRight:4 }}>
        {isSidebarLoading ? (
          <div style={{ display:'flex',flexDirection:'column',gap:8,paddingTop:4 }}>
            {[0,1,2].map(i => <div key={i} style={{ display:'flex',flexDirection:'column',gap:6,padding:'10px',borderRadius:9,border:'1px solid var(--border)',background:'var(--surface2)' }}><div className="skeleton-bar" style={{ height:11,width:'70%',borderRadius:6 }}/><div className="skeleton-bar" style={{ height:9,width:'45%',borderRadius:6,opacity:0.6 }}/></div>)}
          </div>
        ) : conversations.length===0 ? (
          <div style={{ display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:10,padding:'44px 16px',color:'var(--muted)',opacity:0.5 }}>
            <MessageSquare size={28}/>
            <div style={{ fontSize:'0.71rem',textAlign:'center',lineHeight:1.7 }}>{t.noConversations.split('\n').map((l,i)=><span key={i}>{l}{i===0&&<br/>}</span>)}</div>
          </div>
        ) : filtered.length===0 ? (
          <div style={{ textAlign:'center',color:'var(--muted)',fontSize:'0.71rem',padding:'30px 0',opacity:0.5 }}>{t.noResults}</div>
        ) : grouped.map((group, gi) => (
          <div key={group.label} style={{ marginBottom:8 }}>
            <div style={{ fontSize:'0.58rem',letterSpacing:'0.1em',textTransform:'uppercase',color:'var(--muted)',padding:'5px 6px 3px',opacity:0.6 }}>{GROUP_LABELS[gi]??group.label}</div>
            {group.items.map(convo => {
              const msgCount = (convo.id === activeId && activeMessages.length > 0)
                ? activeMessages.length
                : (convo.messageCount ?? convo.messages.length)
              return (
                <div key={convo.id} onClick={()=>openConvo(convo.id)} style={{ display:'flex',alignItems:'center',padding:'8px 8px',borderRadius:9,cursor:'pointer',marginBottom:2,transition:'all 0.15s',background:activeId===convo.id?'var(--surface2)':'transparent',border:activeId===convo.id?'1px solid var(--border)':'1px solid transparent' }} onMouseEnter={e=>{ if(activeId!==convo.id)(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)' }} onMouseLeave={e=>{ if(activeId!==convo.id)(e.currentTarget as HTMLElement).style.background='transparent' }}>
                  <div style={{ flex:1,minWidth:0 }}>
                    <div style={{ fontSize:'0.75rem',color:'var(--text)',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',fontWeight:activeId===convo.id?600:400 }}>{convo.title}</div>
                    <div style={{ display:'flex',alignItems:'center',gap:4,marginTop:2 }}>
                      <Clock size={9} color="var(--muted)"/>
                      <span style={{ fontSize:'0.59rem',color:'var(--muted)' }}>{formatDate(convo.updatedAt)}</span>
                      <span style={{ fontSize:'0.59rem',color:'var(--muted)',opacity:0.4 }}>·</span>
                      <span style={{ fontSize:'0.59rem',color:'var(--muted)',opacity:0.6 }}>{msgCount} {t.messages}</span>
                    </div>
                  </div>
                  <button onClick={e=>handleDelete(convo.id,e)} style={{ background:'transparent',border:'1px solid transparent',borderRadius:6,padding:'4px',color:'var(--muted)',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',transition:'all 0.15s',flexShrink:0,marginLeft:4 }} onMouseEnter={e=>{ (e.currentTarget.style.background='rgba(239,68,68,0.12)');(e.currentTarget.style.borderColor='rgba(239,68,68,0.3)');(e.currentTarget.style.color='#ef4444') }} onMouseLeave={e=>{ (e.currentTarget.style.background='transparent');(e.currentTarget.style.borderColor='transparent');(e.currentTarget.style.color='var(--muted)') }}>
                    <Trash2 size={11}/>
                  </button>
                </div>
              )
            })}
          </div>
        ))}
      </div>

      <div style={{ flexShrink:0, paddingTop:12, borderTop:'1px solid var(--border)', marginTop:8 }}>
        <div style={{ fontSize:'0.61rem', color:'var(--muted)', textAlign:'center', opacity:0.4, padding:'4px 0' }}>
          {BRAND.name} · {BRAND.version}
        </div>
      </div>
    </div>
  )
})

// =======
// MAIN ChatApp
// =======
export default function ChatApp() {
  const router = useRouter()
  const { data: session } = useSession()
  const userName  = session?.user?.name  ?? 'User'
  const userEmail = session?.user?.email ?? ''
  const userImage = session?.user?.image ?? null
  const isLoggedIn = !!userEmail

  function pushSlug(id: string) { if (typeof window !== 'undefined') window.history.pushState(null, '', `/chat/${id}`) }
  function resetUrl()           { if (typeof window !== 'undefined') window.history.pushState(null, '', '/chat') }

  const [conversations, setConversations]     = useState<Conversation[]>([])
  const [activeId, setActiveId]               = useState<string | null>(null)
  const [messages, setMessages]               = useState<ChatMessage[]>([])
  const [isStreaming, setIsStreaming]         = useState(false)
  const [abortController, setAbortController] = useState<AbortController | null>(null)
  const [truncated, setTruncated]             = useState<TruncatedState | null>(null)
  const [isContinuing, setIsContinuing]       = useState(false)
  const [showUpgrade, setShowUpgrade]         = useState(false)
  const [deleteModal, setDeleteModal]         = useState<{ id: string; title: string } | null>(null)
  const [isSidebarLoading, setIsSidebarLoading] = useState(true)
  const [isChatLoading, setIsChatLoading]       = useState(true)
  const [isLoadingConversations]                = useState(false)
  const [isLoadingMessages]                     = useState(false)

  const [trialStatus, setTrialStatus] = useState<{
    isFree:      boolean
    isExpired:   boolean
    tokensUsed:  number
    tokensLeft:  number | null
    tokenQuota:  number | null
    pctUsed:     number
    daysLeft:    number | null
    resetAt:     string | null
  } | null>(null)
  const [showTrialExpired, setShowTrialExpired] = useState(false)
  const [showPaymentPopup, setShowPaymentPopup] = useState(false)
  const [showQuotaResetPopup, setShowQuotaResetPopup] = useState(false)
  const quotaResetShownRef = useRef(false)
  const [showSheetAnalyzer,  setShowSheetAnalyzer]  = useState(false)
  const [showDataCanvas,    setShowDataCanvas]    = useState(false)
  const [showScraper,       setShowScraper]       = useState(false)
  const [showLocationAgent, setShowLocationAgent] = useState(false)
  const [showDriveExplorer, setShowDriveExplorer] = useState(false)
  const [locationAutoQuery, setLocationAutoQuery] = useState<string | null>(null)
  const [showFormBuilder, setShowFormBuilder] = useState(false)
  const [pastedArtifacts, setPastedArtifacts]     = useState<PastedArtifact[]>([])
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [previewArtifact, setPreviewArtifact]      = useState<PastedArtifact | null>(null)
  const [isMobileView, setIsMobileView]            = useState(false)
  const artifactCounter                            = useRef(0)
  const [activeCanvas, setActiveCanvas] = useState<DataCanvas | null>(null)
  const [artifactStore, setArtifactStore] = useState<Record<string, PastedArtifact>>({})

  const externalSetInputRef = useRef<((val: string) => void) | null>(null)
  const externalFocusRef    = useRef<(() => void) | null>(null)

  const setInputFromOutside = useCallback((value: string) => {
    externalSetInputRef.current?.(value)
    setTimeout(() => externalFocusRef.current?.(), 50)
  }, [])

  const focusInput = useCallback(() => { setTimeout(() => externalFocusRef.current?.(), 80) }, [])

  const [navProgress, setNavProgress]   = useState(false)
  const [usage, setUsage]               = useState<Usage | null>(null)
  const [selectedGroup, setSelectedGroup] = useState<ModelGroupKey>('deep')
  const [systemPrompt, setSystemPrompt] = useState(
    'You are a helpful, smart, and friendly AI assistant. Always follow language instructions strictly. ' +
    'When the user asks about nearby places, food, restaurants, cafes, hotels, or any location-based query, ' +
    'respond briefly (1-2 sentences max) that you are searching for nearby locations, then let the Location Agent handle the results. ' +
    'Do NOT say you cannot recommend places. Do NOT ask for the city. The system already has GPS access.'
  )
  const [sidebarOpen, setSidebarOpen]       = useState(false)
  const [searchQ, setSearchQ]               = useState('')
  const [activeTheme, setActiveTheme]       = useState<string>('original')
  const [activeDot, setActiveDot]           = useState<string>(BRAND.accentColor)
  const [activeFont, setActiveFont]         = useState('dm-mono')
  const [fontSize, setFontSize]             = useState(14)
  const [activeLang, setActiveLang]         = useState<LangKey>('id')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [copiedId, setCopiedId]             = useState<string | null>(null)
  const [audioState, setAudioState]         = useState<AudioState>({ isPlaying: false, currentMessageId: null })
  const [currentError, setCurrentError]     = useState<ErrorMessage | null>(null)
  const [showError, setShowError]           = useState(false)

  const endRef      = useRef<HTMLDivElement>(null)
  const inputRef    = useRef<HTMLTextAreaElement>(null)
  const audioRef    = useRef<HTMLAudioElement | null>(null)
  const chatAreaRef = useRef<HTMLDivElement>(null)
  const streamingBubbleRef = useRef<HTMLSpanElement | null>(null)
  const [showScrollDown, setShowScrollDown] = useState(false)
  const [scrollBtnBottom, setScrollBtnBottom] = useState(80)

  const messagesRef        = useRef<ChatMessage[]>([])
  const conversationsRef   = useRef<Conversation[]>([])
  const activeIdRef        = useRef<string | null>(null)
  const selectedGroupRef   = useRef<ModelGroupKey>('deep')
  const systemPromptRef    = useRef<string>('You are a helpful, smart, and friendly AI assistant.')
  const activeLangRef      = useRef<LangKey>('id')
  const isBusyRef          = useRef<boolean>(false)

  const t = LANGUAGES[activeLang].ui
  const isLight = LIGHT_THEMES.has(activeTheme)
  const isBusy = isStreaming || isContinuing

  messagesRef.current      = messages
  conversationsRef.current = conversations
  activeIdRef.current      = activeId
  selectedGroupRef.current = selectedGroup
  systemPromptRef.current  = systemPrompt
  activeLangRef.current    = activeLang
  isBusyRef.current        = isBusy

  // =======
  // DB / SYNC HELPERS
  // =======
  function dbConvToLocal(dbConv: {
    id: string; title: string; model: string; created_at: string; updated_at: string
    message_count?: number
    messages?: Array<{
      role: string; content: string; search_used?: boolean
      is_stopped?: boolean; created_at: string
    }>
  }): Conversation {
    const msgs = (dbConv.messages ?? [])
      .map(m => ({
        role:         m.role as 'user' | 'assistant',
        content:      m.content,
        timestamp:    new Date(m.created_at).getTime(),
        searchUsed:   m.search_used    ?? false,
        isStopped:    m.is_stopped     ?? false,
        isError:      false,
        canRetry:     false,
        isTruncated:  false,
      }))
      .sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0
        if (!a.timestamp) return -1
        if (!b.timestamp) return 1
        return a.timestamp - b.timestamp
      })

    return {
      id:           dbConv.id,
      title:        dbConv.title,
      model:        dbConv.model,
      createdAt:    new Date(dbConv.created_at).getTime(),
      updatedAt:    new Date(dbConv.updated_at).getTime(),
      messages:     msgs,
      messageCount: dbConv.message_count,
    }
  }

  function syncConversationToDb(conv: Conversation) {
    if (!isLoggedIn) return
    fetch('/api/conversations', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ id:conv.id, title:conv.title, model:conv.model, createdAt:new Date(conv.createdAt).toISOString(), updatedAt:new Date(conv.updatedAt).toISOString() }) }).catch(() => {})
  }

  async function loadConversationsHybrid(): Promise<Conversation[]> {
    if (isLoggedIn) {
      try {
        const res = await fetch('/api/conversations', { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        const dbConvs: Conversation[] = (data.conversations ?? []).map(
          (c: Parameters<typeof dbConvToLocal>[0]) => dbConvToLocal(c)
        ).map((conv: Conversation) => ({
          ...conv,
          messages: [...conv.messages].sort((a, b) => {
            if (!a.timestamp && !b.timestamp) return 0
            if (!a.timestamp) return -1
            if (!b.timestamp) return 1
            return a.timestamp - b.timestamp
          })
        }))
        saveConversations(dbConvs)
        return dbConvs
      } catch {
        return loadConversations()
      }
    }
    return loadConversations()
  }

  async function deleteConversationHybrid(id: string) {
    deleteConversation(id)
    if (isLoggedIn) fetch(`/api/conversations/${id}`, { method:'DELETE' }).catch(() => {})
  }

  async function clearAllHybrid() {
    clearAllConversations()
    if (isLoggedIn) fetch('/api/conversations', { method:'DELETE' }).catch(() => {})
  }

  async function loadConvMessagesFromDb(convId: string): Promise<ChatMessage[] | null> {
    if (!isLoggedIn) return null
    try {
      const res = await fetch(`/api/conversations/${convId}`)
      if (!res.ok) return null
      const data = await res.json()
      if (!data.conversation?.messages) return null

      const msgs: ChatMessage[] = data.conversation.messages
        .map((m: {
          role: string; content: string; search_used?: boolean
          is_stopped?: boolean; created_at: string
        }) => ({
          role:          m.role as 'user' | 'assistant',
          content:       m.content,
          timestamp:     new Date(m.created_at).getTime(),
          searchUsed:    m.search_used     ?? false,
          isStopped:     m.is_stopped      ?? false,
          isError:       false,
          canRetry:      false,
          isTruncated:   false,
        }))
        .sort((a: { timestamp: number }, b: { timestamp: number }) => {
          if (!a.timestamp && !b.timestamp) return 0
          if (!a.timestamp) return -1
          if (!b.timestamp) return 1
          return a.timestamp - b.timestamp
        })

      return msgs
    } catch {
      return null
    }
  }

  // =======
  // EFFECTS
  // =======
  useEffect(() => { document.body.classList.add('chat-page'); return () => document.body.classList.remove('chat-page') }, [])

  useEffect(() => {
    const check = () => setIsMobileView(window.innerWidth <= 640)
    check()
    window.addEventListener('resize', check)
    return () => window.removeEventListener('resize', check)
  }, [])

  const refreshTrialStatus = useCallback(() => {
    if (!isLoggedIn) return
    fetch('/api/user/trial')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        setTrialStatus(data)
        if (data.isExpired) setShowTrialExpired(true)

        // auto popup quota reset saat kuota baru saja habis
        const isOut = data.isExpired || (data.tokensLeft !== null && data.tokensLeft <= 0)
        if (isOut && !quotaResetShownRef.current) {
          quotaResetShownRef.current = true
          setShowQuotaResetPopup(true)
        }
      })
      .catch(() => {})
  }, [isLoggedIn])

  useEffect(() => { refreshTrialStatus() }, [refreshTrialStatus])

  useEffect(() => {
    function syncFromStorage() {
      const savedTheme = localStorage.getItem('conversaTheme')
      if (savedTheme) {
        const th = THEMES.find(x => x.key === savedTheme)
        if (th) {
          setActiveTheme(th.key); setActiveDot(th.dot)
          if (th.attr) document.documentElement.setAttribute('data-theme', th.attr)
          else         document.documentElement.removeAttribute('data-theme')
        }
      }
      const savedFont = localStorage.getItem('conversaFont')
      if (savedFont) {
        const font = FONTS.find(f => f.key === savedFont)
        if (font) { document.body.style.fontFamily = font.family; setActiveFont(savedFont) }
      }
      const savedSize = localStorage.getItem('conversaFontSize')
      if (savedSize) {
        const s = parseInt(savedSize)
        if (s >= 11 && s <= 20) {
          document.documentElement.style.fontSize = `${s}px`
          document.body.style.fontSize = `${s}px`
          setFontSize(s)
        }
      }
      const savedLang = localStorage.getItem('conversaLang') as LangKey | null
      if (savedLang && LANGUAGES[savedLang]) { setActiveLang(savedLang); activeLangRef.current = savedLang }
    }
    function onLangChange(e: Event) {
      const lang = (e as CustomEvent<LangKey>).detail
      if (lang && LANGUAGES[lang]) { setActiveLang(lang); activeLangRef.current = lang }
    }
    syncFromStorage()
    window.addEventListener('storage', syncFromStorage)
    window.addEventListener('conversaLangChange', onLangChange)
    return () => {
      window.removeEventListener('storage', syncFromStorage)
      window.removeEventListener('conversaLangChange', onLangChange)
    }
  }, [])

  useEffect(() => {
    const savedGroup = localStorage.getItem('conversaSelectedGroup') as ModelGroupKey | null
    if (savedGroup && ['flash','smart','deep','elite'].includes(savedGroup)) {
      setSelectedGroup(savedGroup); selectedGroupRef.current = savedGroup
    }
    if (isLoggedIn) {
      fetch('/api/user/settings?key=font_size').then(r=>r.json()).then(data=>{
        if (data?.value) { const s = parseInt(data.value); if (s>=11&&s<=20) applyFontSize(s, false) }
      }).catch(()=>{})
    }

    const localConvs = loadConversations().map((conv: Conversation) => ({
      ...conv,
      messages: [...conv.messages].sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0
        if (!a.timestamp) return -1
        if (!b.timestamp) return 1
        return a.timestamp - b.timestamp
      })
    }))
    if (localConvs.length > 0) {
      setConversations(localConvs)
      setIsSidebarLoading(false)
    } else {
      setIsSidebarLoading(true)
    }

    loadConversationsHybrid().then(convs => {
      setConversations(convs)
    }).finally(() => setIsSidebarLoading(false))
  }, [isLoggedIn])

  useEffect(() => {
    if (!activeId || messages.length === 0) return
    setConversations(prev => prev.map(c =>
      c.id === activeId ? { ...c, messages } : c
    ))
  }, [activeId, messages.length])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const parts = window.location.pathname.split('/')
    const slug = parts.length===3 && parts[1]==='chat' && parts[2] ? parts[2] : null
    if (!slug) { setIsChatLoading(false); return }
    const loadAndOpen = async () => {
      setIsChatLoading(true)
      try {
        if (isLoggedIn) {
          const [convs, dbMsgs] = await Promise.all([
            loadConversationsHybrid(),
            loadConvMessagesFromDb(slug),
          ])
          setConversations(convs)

          const conv = convs.find(x => x.id === slug)
          if (conv?.model) {
            const g = getModelTier_client(conv.model)
            setSelectedGroup(g)
            selectedGroupRef.current = g
          }

          if (dbMsgs && dbMsgs.length > 0) {
            const cleanMsgs = dbMsgs
              .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content?.trim()))
              .map(m => ({ ...m, isError: false, canRetry: false, isTruncated: false }))
              .sort((a, b) => {
                if (!a.timestamp && !b.timestamp) return 0
                if (!a.timestamp) return -1
                if (!b.timestamp) return 1
                return a.timestamp - b.timestamp
              })
            setMessages(cleanMsgs)
            setIsChatLoading(false)
            setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'auto' }), 80)
            return
          }
        }
      } catch {
        // DB gagal → fallback localStorage
      }

      const localConvs = loadConversations()
      setConversations(localConvs)
      const localConv = localConvs.find(x => x.id === slug)

      if (!localConv) {
        window.history.replaceState(null, '', '/chat')
        setIsChatLoading(false)
        return
      }

      if (localConv.model) {
        const g = getModelTier_client(localConv.model)
        setSelectedGroup(g)
        selectedGroupRef.current = g
      }

      if (localConv.messages?.length) {
        const cleanMsgs = localConv.messages
          .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content?.trim()))
          .map(m => ({ ...m, isError: false, canRetry: false, isTruncated: false }))
          .sort((a, b) => {
            if (!a.timestamp && !b.timestamp) return 0
            if (!a.timestamp) return -1
            if (!b.timestamp) return 1
            return a.timestamp - b.timestamp
          })
        setMessages(cleanMsgs)
      }

      setIsChatLoading(false)
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'auto' }), 80)
    }
    loadAndOpen()
  }, [])

  useEffect(() => {
    const h = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('[data-popup]')) { setMobileMenuOpen(false) }
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key==='Escape') { setDeleteModal(null); setShowPaymentPopup(false) } }; document.addEventListener('keydown', h); return () => document.removeEventListener('keydown', h) }, [])
  useEffect(() => { const h = () => { if (window.innerWidth>700) setSidebarOpen(false) }; window.addEventListener('resize', h); return () => window.removeEventListener('resize', h) }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ behavior:'smooth' }) }, [messages])

  useEffect(() => {
    const el = chatAreaRef.current
    if (!el) return
  
    const updateBtn = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      setShowScrollDown(distanceFromBottom > 120)
  
      // hitung bottom: jarak dari bawah el ke bawah viewport
      const rect = el.getBoundingClientRect()
      const bottomGap = window.innerHeight - rect.bottom
      setScrollBtnBottom(bottomGap + 16)
    }
  
    el.addEventListener('scroll', updateBtn, { passive: true })
  
    // observer untuk deteksi perubahan tinggi (textarea memanjang, dll)
    const ro = new ResizeObserver(updateBtn)
    ro.observe(el)
    // observe main juga agar ikut saat input area berubah tinggi
    if (el.parentElement) ro.observe(el.parentElement)
  
    updateBtn()
    return () => {
      el.removeEventListener('scroll', updateBtn)
      ro.disconnect()
    }
  }, [])
  useEffect(() => { return () => { if (audioRef.current) { audioRef.current.pause(); audioRef.current = null } } }, [])

  // =======
  // THEME / FONT / LANG
  // =======
  function applyTheme(key: string, attr: string|null, dot: string, save=true) {
    if (attr) document.documentElement.setAttribute('data-theme', attr)
    else document.documentElement.removeAttribute('data-theme')
    setActiveTheme(key); setActiveDot(dot)
    if (save) localStorage.setItem('conversaTheme', key)
  }
  function applyFont(key: string, save=true) {
    const font = FONTS.find(f => f.key===key); if (!font) return
    if (FONT_URLS[key] && !document.querySelector(`link[data-font="${key}"]`)) { const link=document.createElement('link'); link.rel='stylesheet'; link.href=FONT_URLS[key]; link.setAttribute('data-font',key); document.head.appendChild(link) }
    document.body.style.fontFamily = font.family; setActiveFont(key)
    if (save) localStorage.setItem('conversaFont', key)
  }
  function applyFontSize(size: number, save=true) {
    const clamped = Math.min(20, Math.max(11, size)); setFontSize(clamped)
    document.documentElement.style.fontSize = `${clamped}px`; document.body.style.fontSize = `${clamped}px`
    localStorage.setItem('conversaFontSize', String(clamped))
    if (save && isLoggedIn) { fetch('/api/user/settings', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ key:'font_size', value:String(clamped) }) }).catch(()=>{}) }
  }
  function applyLang(key: LangKey, save=true) { setActiveLang(key); activeLangRef.current = key; if (save) localStorage.setItem('conversaLang', key) }
  function handleLogout() { localStorage.removeItem('conversaTheme'); localStorage.removeItem('conversaFont'); localStorage.removeItem('conversaLang'); signOut({ callbackUrl:'/' }) }

  // =======
  // CHAT ACTIONS
  // =======
  function startNewChat() { setActiveId(null); setMessages([]); setUsage(null); setInputFromOutside(''); setCurrentError(null); setShowError(false); setSidebarOpen(false); resetUrl(); setTruncated(null); setIsContinuing(false); focusInput() }

  async function openConvo(id: string) {
    setNavProgress(true); setTimeout(() => setNavProgress(false), 500)
    setActiveId(id)
    setUsage(null)
    setCurrentError(null)
    setShowError(false)
    setSidebarOpen(false)
    setTruncated(null)
    setIsContinuing(false)
    pushSlug(id)
    setIsChatLoading(true)

    const cached = conversations.find(x => x.id === id)
    if (cached?.model) {
      const g = getModelTier_client(cached.model)
      setSelectedGroup(g)
      selectedGroupRef.current = g
    }

    let loaded = false

    if (isLoggedIn) {
      const dbMsgs = await loadConvMessagesFromDb(id)
      if (dbMsgs && dbMsgs.length > 0) {
        setMessages(dbMsgs)
        const dbConv = conversations.find(x => x.id === id)
        if (dbConv?.model) {
          const g = getModelTier_client(dbConv.model)
          setSelectedGroup(g)
          selectedGroupRef.current = g
        }
        upsertConversation({
          ...(cached ?? {
            id, title: '', model: 'deep',
            messages: [], createdAt: Date.now(), updatedAt: Date.now(),
          }),
          messages: dbMsgs,
        })
        loaded = true
      }
    }

    if (!loaded && cached?.messages?.length) {
      const normalizedMsgs = cached.messages
        .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content?.trim()))
        .map(m => ({
          ...m,
          isError:           false,
          canRetry:          false,
          isTruncated:       false,
        }))
        .sort((a, b) => {
          if (!a.timestamp && !b.timestamp) return 0
          if (!a.timestamp) return -1
          if (!b.timestamp) return 1
          return a.timestamp - b.timestamp
        })
      setMessages(normalizedMsgs)
    }

    setIsChatLoading(false)
    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'auto' }), 60)
  }

  function handleDelete(id: string, e: React.MouseEvent) { e.stopPropagation(); e.preventDefault(); const convo=conversations.find(c=>c.id===id); setDeleteModal({ id, title:convo?.title??t.convFallbackTitle }) }
  function confirmDelete() { if (!deleteModal) return; deleteConversationHybrid(deleteModal.id); setConversations(prev=>prev.filter(c=>c.id!==deleteModal.id)); if (activeId===deleteModal.id) startNewChat(); setDeleteModal(null) }
  function handleClearAll() { if (!confirm(t.clearAll+'?')) return; clearAllHybrid(); setConversations([]); startNewChat() }

  function isQuotaError(raw: unknown): boolean { const low=(raw instanceof Error?raw.message:String(raw)).toLowerCase(); return /quota|exceeded|limit reached|insufficient.credit|billing|upgrade|plan|out of token|no credits/.test(low) }
  function categorizeError(raw: unknown): ErrorMessage {
    const low=(raw instanceof Error?raw.message:String(raw)).toLowerCase()
    if (isQuotaError(raw)) return { type:'quota', message:t.quotaExceeded, originalError:raw instanceof Error?raw.message:String(raw), timestamp:Date.now(), canRetry:false, isQuotaExceeded:true }
    if (/network|fetch|body|connect|abort|econnrefused|enotfound/.test(low)) return { type:'network', message:t.errorNetwork, originalError:raw instanceof Error?raw.message:String(raw), timestamp:Date.now(), canRetry:true }
    if (/rate|429|throttl|too many/.test(low)) return { type:'rate', message:t.errorRate, originalError:raw instanceof Error?raw.message:String(raw), timestamp:Date.now(), canRetry:true }
    if (/api|service|500|502|503|504/.test(low)) return { type:'api', message:t.errorApi, originalError:raw instanceof Error?raw.message:String(raw), timestamp:Date.now(), canRetry:true }
    return { type:'other', message:t.errorOther, originalError:raw instanceof Error?raw.message:String(raw), timestamp:Date.now(), canRetry:true }
  }

  async function copyToClipboard(text: string, messageId: string) { try { await navigator.clipboard.writeText(text); setCopiedId(messageId); setTimeout(() => setCopiedId(null), 2000) } catch (err) { console.error(err) } }
  function speakText(text: string, messageId: string) {
    if (!window.speechSynthesis) { alert('Text-to-speech not supported'); return }
    if (audioState.isPlaying && audioState.currentMessageId===messageId) { window.speechSynthesis.cancel(); setAudioState({ isPlaying:false, currentMessageId:null }); return }
    window.speechSynthesis.cancel()
    const cleanText = text.replace(/```[\s\S]*?```/g,'').replace(/`[^`]+`/g,'').replace(/\*{1,3}([^*]+)\*{1,3}/g,'$1').replace(/^#{1,6}\s+/gm,'').replace(/https?:\/\/\S+/g,'').replace(/[#*_~`]/g,'').trim()
    const utterance = new SpeechSynthesisUtterance(cleanText)
    utterance.lang = activeLang==='id'?'id-ID':activeLang==='en'?'en-US':activeLang==='ar'?'ar-SA':activeLang==='zh'?'zh-CN':activeLang==='ja'?'ja-JP':activeLang==='ko'?'ko-KR':activeLang==='es'?'es-ES':'fr-FR'
    utterance.onstart = () => setAudioState({ isPlaying:true, currentMessageId:messageId })
    utterance.onend   = () => setAudioState({ isPlaying:false, currentMessageId:null })
    utterance.onerror = () => setAudioState({ isPlaying:false, currentMessageId:null })
    window.speechSynthesis.speak(utterance)
  }
  const stopStreaming = () => { if (abortController) { abortController.abort(); setIsStreaming(false); setAbortController(null) } }

  async function runStream({ history, curModel, curSystemPrompt, convId, isNew, curConversations, existingTitle, now, targetMessageIndex, initialContent, controller }: {
    history: { role:string; content:string | { type:string; text?:string; image_url?:{ url:string } }[] }[]; curModel:string; curSystemPrompt:string
    convId:string; isNew:boolean; curConversations:Conversation[]; existingTitle?:string
    now:number; targetMessageIndex:number; initialContent:string; controller:AbortController
  }): Promise<{ fullText:string; finishReason:string|null; isQuota:boolean }> {
    let fullText = initialContent, finishReason: string|null = null, isQuota = false
    const rawContent = history[history.length-1]?.content ?? ''
    const userText = typeof rawContent === 'string'
      ? rawContent
      : rawContent.find(b => b.type === 'text')?.text ?? ''
    const langInstruction = detectLangInstruction(userText)
    const res = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ message:userText, model:curModel, modelGroup:curModel, systemPrompt:langInstruction+'\n\n'+curSystemPrompt, history:history.slice(0,-1), sessionId:convId, conversationId:convId, conversationTitle:existingTitle??generateTitle(userText) }), signal:controller.signal })
    if (!res.ok && res.status!==200) {
      let errMsg = t.errorOther
      let isTrialExpired = false
      try {
        const j = await res.json()
        if (j?.code === 'TRIAL_EXPIRED' || res.status === 403) {
          isTrialExpired = true
          setTrialStatus(prev => prev ? { ...prev, isExpired: true, tokensLeft: 0, pctUsed: 100 } : null)
          setShowTrialExpired(true)
          errMsg = j?.error ?? t.trialExpiredErrMsg
        } else if (j?.error) {
          const error = categorizeError(new Error(j.error))
          if (error.isQuotaExceeded) { isQuota = true; setShowTrialExpired(true) }
          else { setCurrentError(error); setShowError(true) }
          errMsg = error.message
        }
      } catch {}
      setMessages(prev => { const u=[...prev]; if(u[targetMessageIndex]) u[targetMessageIndex]={...u[targetMessageIndex],content:errMsg,isError:!isTrialExpired,canRetry:false,isTruncated:false}; return u })
      return { fullText:errMsg, finishReason:'error', isQuota }
    }
    if (!res.body) throw new Error('No response body')
    const reader=res.body.getReader(); const decoder=new TextDecoder(); let buffer=''
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      buffer += decoder.decode(value, { stream:true })
      const parts=buffer.split('\n\n'); buffer=parts.pop()??''
      for (const part of parts) {
        const em=part.match(/^event: (\w+)/m); const dm=part.match(/^data: (.+)/m)
        if (!em||!dm) continue
        let p: Record<string,unknown>; try { p=JSON.parse(dm[1]) } catch { continue }
        if (em[1]==='token' && typeof p.text==='string') {
          fullText += p.text
          // Direct DOM write untuk smooth typing — bypass React re-render
          if (streamingBubbleRef.current) {
            streamingBubbleRef.current.innerHTML = renderMd(fullText)
          } else {
            // Fallback ke React state jika ref belum siap
            const snap = fullText
            setMessages(prev => {
              const u = [...prev]
              if (u[targetMessageIndex]) u[targetMessageIndex] = { ...u[targetMessageIndex], content: snap, isTruncated: false }
              return u
            })
          }
        }
        else if (em[1]==='search') { if(p.used===true) setMessages(prev=>{ const u=[...prev]; if(u[targetMessageIndex]) u[targetMessageIndex]={...u[targetMessageIndex],searchUsed:true}; return u }) }
        else if (em[1]==='sources') { if(p.items) setMessages(prev=>{ const u=[...prev]; if(u[targetMessageIndex]) u[targetMessageIndex]={...u[targetMessageIndex],sources:p.items as {title:string;url:string}[]}; return u }) }
        else if (em[1]==='done') { if(p.usage) setUsage(p.usage as Usage); if(typeof p.finish_reason==='string') finishReason=p.finish_reason }
        else if (em[1]==='error') { const raw=typeof p.message==='string'?p.message:t.errorOther; const error=categorizeError(new Error(raw)); if(error.isQuotaExceeded){isQuota=true;setShowTrialExpired(true)} else{setCurrentError(error);setShowError(true)}; finishReason='error'; fullText=initialContent+(fullText.replace(initialContent,'')||raw); setMessages(prev=>{ const u=[...prev]; if(u[targetMessageIndex]) u[targetMessageIndex]={...u[targetMessageIndex],content:fullText,isError:!isQuota,isTruncated:false}; return u }) }
      }
    }
    return { fullText, finishReason, isQuota }
  }

  // =======
  // Deteksi apakah teks user mengandung intent pencarian lokasi
  // Contoh: "ada rumah makan di sini?", "kafe terdekat dong"
  // =======
  function detectLocationIntent(text: string): string | null {
    const lower = text.toLowerCase()
  
    // Kata sinyal lokasi
    const locationSignals = [
      'di sini', 'di dekat', 'di sekitar', 'terdekat', 'deket sini',
      'dekat sini', 'sekitar sini', 'deket aku', 'dekat aku',
      'nearby', 'near me', 'near here', 'around here', 'closest',
      'in my area', 'around me',
    ]
  
    // Kata tipe tempat
    const placeKeywords = [
      'rumah makan', 'restoran', 'restaurant', 'warung', 'makan', 'makan siang',
      'makan malam', 'sarapan', 'kuliner', 'food', 'eat', 'dining',
      'kafe', 'cafe', 'coffee', 'kedai kopi', 'minuman',
      'hotel', 'penginapan', 'inn', 'lodge', 'motel', 'homestay',
      'rumah sakit', 'klinik', 'dokter', 'apotek', 'hospital', 'clinic',
      'mall', 'supermarket', 'minimarket', 'toko', 'belanja', 'shopping',
      'bbm', 'bensin', 'spbu', 'pom bensin', 'gas station', 'pertamina',
      'atm', 'bank', 'kantor', 'office',
      'sekolah', 'kampus', 'universitas', 'school', 'university',
      'wisata', 'tempat wisata', 'destinasi', 'tourist', 'attraction',
      'masjid', 'gereja', 'mushola', 'mosque', 'church', 'temple',
      'halte', 'terminal', 'stasiun', 'bandara', 'airport', 'station',
    ]
  
    // Intent kata tanya / permintaan
    const intentWords = [
      'ada', 'cari', 'cariin', 'dimana', 'di mana', 'mana ada', 'ada gak',
      'ada tidak', 'ada ga', 'rekomendasi', 'rekomen', 'suggest', 'recommend',
      'where', 'find', 'looking for', 'want to go', 'any', 'closest',
      'lapar', 'laper', 'hungry', 'haus', 'thirsty', 'butuh', 'need',
      'cari tau', 'tau gak', 'tau tidak',
    ]
  
    const hasLocation = locationSignals.some(s => lower.includes(s))
    const hasPlace    = placeKeywords.some(k => lower.includes(k))
    const hasIntent   = intentWords.some(w => lower.includes(w))
  
    // Harus ada minimal: (sinyal lokasi + kata tempat) ATAU (kata tempat + intent)
    if (!hasPlace) return null
    if (!hasLocation && !hasIntent) return null
  
    // Ekstrak keyword tempat yang paling relevan untuk dijadikan query pencarian
    const found = placeKeywords.find(k => lower.includes(k)) ?? ''
  
    // Mapping ke query HERE Maps yang lebih spesifik
    const queryMap: Record<string, string> = {
      'rumah makan':  'restaurant',
      'restoran':     'restaurant',
      'restaurant':   'restaurant',
      'warung':       'restaurant local food',
      'makan':        'restaurant',
      'makan siang':  'restaurant lunch',
      'makan malam':  'restaurant dinner',
      'sarapan':      'restaurant breakfast',
      'kuliner':      'restaurant food',
      'food':         'restaurant',
      'eat':          'restaurant',
      'dining':       'restaurant',
      'kafe':         'kafe coffee shop terdekat',
      'cafe':         'cafe coffee shop nearby',
      'coffee':       'coffee shop cafe nearby',
      'kedai kopi':   'kedai kopi kafe terdekat',
      'hotel':        'hotel penginapan terdekat',
      'penginapan':   'penginapan hotel terdekat',
      'rumah sakit':  'rumah sakit terdekat',
      'klinik':       'klinik dokter terdekat',
      'dokter':       'dokter klinik terdekat',
      'apotek':       'apotek terdekat',
      'hospital':     'hospital clinic nearby',
      'mall':         'mall pusat perbelanjaan terdekat',
      'supermarket':  'supermarket terdekat',
      'minimarket':   'minimarket terdekat',
      'toko':         'toko terdekat',
      'belanja':      'mall toko belanja terdekat',
      'spbu':         'SPBU pom bensin terdekat',
      'bensin':       'pom bensin SPBU terdekat',
      'atm':          'ATM bank terdekat',
      'bank':         'bank ATM terdekat',
      'sekolah':      'sekolah terdekat',
      'kampus':       'kampus universitas terdekat',
      'wisata':       'tempat wisata terdekat',
      'masjid':       'masjid mushola terdekat',
      'gereja':       'gereja terdekat',
      'halte':        'halte bus terdekat',
      'stasiun':      'stasiun kereta terdekat',
      'bandara':      'bandara terdekat',
    }
  
    return queryMap[found] ?? `${found} terdekat`
  }

  const addImageAttachment = useCallback((file: File) => {
    if (imageAttachments.length >= 3) return  // max 3
    const reader = new FileReader()
    reader.onload = (e) => {
      const dataUrl = e.target?.result as string
      const base64  = dataUrl.split(',')[1] ?? ''
      const attachment: ImageAttachment = {
        id:         generateId(),
        base64,
        mimeType:   file.type || 'image/jpeg',
        previewUrl: dataUrl,
        filename:   file.name || 'photo.jpg',
      }
      setImageAttachments(prev => [...prev, attachment].slice(0, 3))
    }
    reader.readAsDataURL(file)
  }, [imageAttachments.length])

  const sendMessage = useCallback(async (text: string, skipUserMsg = false) => {
    if (!text || isBusyRef.current) return
    const controller = new AbortController(); setAbortController(controller)
    const now = Date.now()
    const curActiveId = activeIdRef.current
    const convId = curActiveId ?? generateId()
    const isNew = !curActiveId
    const curMessages = messagesRef.current
    const curConversations = conversationsRef.current
    const curGroup = selectedGroupRef.current
    const curSystemPrompt = systemPromptRef.current

    const cleanText = sanitizeText(text)
    // Inject artifact contents
    const currentArtifacts = pastedArtifacts
    let enrichedText = cleanText
    // Bangun content array untuk pesan user (text + images)
    const userContent: Array<{ type: string; text?: string; image_url?: { url: string } }> =
      imageAttachments.length > 0
        ? [
            ...imageAttachments.map(img => ({
              type:      'image_url',
              image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
            })),
            { type: 'text', text: enrichedText },
          ]
        : [{ type: 'text', text: enrichedText }]
    if (currentArtifacts.length > 0) {
      const CHUNK_SIZE = 6000  // chars per artifact, ~1500 tokens
      const MAX_TOTAL_INJECT  = 12_000  // total chars dari semua artifact
      let totalInjected = 0
      const artifactBlock = currentArtifacts.map(a => {
        if (totalInjected >= MAX_TOTAL_INJECT) {
          return `\n\n[File: ${a.filename} — dilewati, batas payload tercapai]`
        }
      
        const allowed = Math.min(a.content.length, CHUNK_SIZE, MAX_TOTAL_INJECT - totalInjected)
        const preview = a.content.slice(0, allowed)
        totalInjected += preview.length
      
        if (a.content.length <= allowed) {
          return `\n\n[File: ${a.filename} (${a.language}, ${formatFileSize(a.size)})]
      \`\`\`${a.language}
      ${preview}
      \`\`\``
        } else {
          const totalLines = a.content.split('\n').length
          const shownLines = preview.split('\n').length
          return `\n\n[File: ${a.filename} (${a.language}, partial ${shownLines}/${totalLines} baris)]
      \`\`\`${a.language}
      ${preview}
      \`\`\`
      [... ${totalLines - shownLines} baris tersembunyi]`
        }
      }).join('')
      enrichedText = cleanText + artifactBlock
    }
    if (!cleanText) return
    
    const userMsg: ChatMessage = { role:'user', content:cleanText, timestamp:now }
    const aiMsg: ChatMessage   = { role:'assistant', content:'', timestamp:now }
    // ── Deteksi intent lokasi dari pesan user ──────────────────
    const locationQuery = detectLocationIntent(cleanText)
    if (locationQuery) {
      // Buka panel location agent + set auto-query
      setLocationAutoQuery(locationQuery)
      setShowLocationAgent(true)
      setShowScraper(false)
      setShowSheetAnalyzer(false)
      setShowDataCanvas(false)
    }

    setMessages(prev => skipUserMsg ? [...prev, aiMsg] : [...prev, userMsg, aiMsg])

    setInputFromOutside('')
    setIsStreaming(true)
    setCurrentError(null)
    setShowError(false)
    setTruncated(null)

    if (isNew) { setActiveId(convId); pushSlug(convId) }
    if (inputRef.current) inputRef.current.style.height = 'auto'

    const targetMessageIndex = skipUserMsg
      ? curMessages.length
      : curMessages.length + 1
    const MAX_CONTEXT_MESSAGES = 6
    const history = [
      ...curMessages.slice(-MAX_CONTEXT_MESSAGES).map(m => ({
        role: m.role,
        content: sanitizeText(m.content)
      })),
      {
        role: 'user',
        content: imageAttachments.length > 0 ? userContent : enrichedText,
      },
    ]
    // Clear artifacts after send
    setPastedArtifacts([])
    setImageAttachments([])
    setPreviewArtifact(null)

    let canvasContext = ''
    if (activeCanvas) {
      try {
        const res  = await fetch(`/api/datacanvas?action=get&id=${activeCanvas.id}`)
        const data = await res.json()
        if (data.canvas) {
          const { buildCanvasContext } = await import('@/lib/datacanvas')
          canvasContext = buildCanvasContext(data.canvas)
        }
      } catch { }
    }
    try {
      const { fullText, finishReason, isQuota } = await runStream({ history, curModel:curGroup, curSystemPrompt, convId, isNew, curConversations, existingTitle:curConversations.find(c=>c.id===convId)?.title, now, targetMessageIndex, initialContent:'', controller })
      const wasTruncated = finishReason==='length'||finishReason==='max_tokens'
      if (wasTruncated && !isQuota) { setMessages(prev=>{ const u=[...prev]; if(u[targetMessageIndex]) u[targetMessageIndex]={...u[targetMessageIndex],isTruncated:true}; return u }); setTruncated({ messageIndex:targetMessageIndex, convId, partialContent:fullText, continuationCount:0 }) }
      else if (isQuota) { setShowTrialExpired(true) }
      const searchUsedFinal = messagesRef.current[targetMessageIndex]?.searchUsed ?? false
      setTimeout(() => refreshTrialStatus(), 500)
      const finalMsgs: ChatMessage[] = [
        ...curMessages,
        ...(skipUserMsg ? [] : [userMsg]),
        {
          role:        'assistant' as const,
          content:     fullText,
          timestamp:   Date.now(),
          isTruncated: wasTruncated && !isQuota,
          searchUsed:  searchUsedFinal,
          isError:     false,
          canRetry:    false,
          isStopped:   false,
        }
      ].sort((a, b) => {
        if (!a.timestamp && !b.timestamp) return 0
        if (!a.timestamp) return -1
        if (!b.timestamp) return 1
        return a.timestamp - b.timestamp
      })
      const existing = curConversations.find(c=>c.id===convId)
      const convToSave: Conversation = { id:convId, title:isNew?generateTitle(text):(existing?.title??generateTitle(text)), model:curGroup, messages:finalMsgs, createdAt:isNew?now:(existing?.createdAt??now), updatedAt:Date.now() }
      upsertConversation(convToSave); syncConversationToDb(convToSave)
      setConversations(prev=>{ const without=prev.filter(c=>c.id!==convToSave.id); return [convToSave,...without].sort((a,b)=>b.updatedAt-a.updatedAt) })
      setMessages(finalMsgs)
    } catch (e) {
      if (e instanceof Error && e.name==='AbortError') {
        setMessages(prev=>{ const u=[...prev]; if(u.length>0) { const last=u[u.length-1]; u[u.length-1]={...last,content:(last.content?.trim()??'')?last.content+'\n\n*⏹ Dihentikan.*':'*⏹ Dihentikan.*',isStopped:true} } return u })
      } else {
        const error=categorizeError(e); if(error.isQuotaExceeded) setShowTrialExpired(true); else{setCurrentError(error);setShowError(true)}
        setMessages(prev=>{ const u=[...prev]; if(u.length>0) u[u.length-1]={...u[u.length-1],content:error.message,isError:!error.isQuotaExceeded,canRetry:error.canRetry}; return u })
      }
    }
    streamingBubbleRef.current = null
    setIsStreaming(false); setAbortController(null)
    setTimeout(() => externalFocusRef.current?.(), 80)
  }, [])

  const continueResponse = useCallback(async () => {
    if (!truncated || isBusyRef.current) return
    const { messageIndex, convId, partialContent, continuationCount } = truncated
    const controller=new AbortController(); setAbortController(controller); setIsContinuing(true); setTruncated(null)
    setMessages(prev=>{ const u=[...prev]; if(u[messageIndex]) u[messageIndex]={...u[messageIndex],isTruncated:false}; return u })
    const curMessages=messagesRef.current, curConversations=conversationsRef.current
    const curGroup=selectedGroupRef.current, curSystemPrompt=systemPromptRef.current, now=Date.now()
    const msgsBeforeTruncated = curMessages.slice(0, messageIndex)
    const continuationInstruction = t.continuationInstr.replace('{snippet}', partialContent.slice(-120).trim())
    const MAX_CONTEXT_MESSAGES = 6
    const history2 = [
      ...msgsBeforeTruncated
        .slice(-MAX_CONTEXT_MESSAGES)
        .map(m => ({ role: m.role, content: m.content })),
      { role: 'assistant', content: partialContent },
      { role: 'user',      content: continuationInstruction },
    ]
    try {
      const { fullText, finishReason, isQuota } = await runStream({ history: history2, curModel:curGroup, curSystemPrompt, convId, isNew:false, curConversations, now, targetMessageIndex:messageIndex, initialContent:partialContent, controller })
      const wasTruncatedAgain = finishReason==='length'||finishReason==='max_tokens'
      if (wasTruncatedAgain && !isQuota) { setMessages(prev=>{ const u=[...prev]; if(u[messageIndex]) u[messageIndex]={...u[messageIndex],isTruncated:true}; return u }); setTruncated({ messageIndex, convId, partialContent:fullText, continuationCount:continuationCount+1 }) }
      else if (isQuota) { setShowTrialExpired(true) }
      setMessages(prev=>{ const u=[...prev]; if(u[messageIndex]) u[messageIndex]={...u[messageIndex],content:fullText,isTruncated:wasTruncatedAgain&&!isQuota,timestamp:now}; const existing=curConversations.find(c=>c.id===convId); const convToSave: Conversation={ id:convId, title:existing?.title??t.convFallbackTitle, model:curGroup, messages:u, createdAt:existing?.createdAt??now, updatedAt:Date.now() }; upsertConversation(convToSave); syncConversationToDb(convToSave); setConversations(prev2=>{ const without=prev2.filter(c=>c.id!==convToSave.id); return [convToSave,...without].sort((a,b)=>b.updatedAt-a.updatedAt) }); return u })
    } catch (e) {
      if (e instanceof Error && e.name==='AbortError') { setMessages(prev=>{ const u=[...prev]; if(u[messageIndex]) u[messageIndex]={...u[messageIndex],isStopped:true,isTruncated:false}; return u }) }
      else { const error=categorizeError(e); if(error.isQuotaExceeded) setShowTrialExpired(true); else{setCurrentError(error);setShowError(true)}; setTruncated({ messageIndex, convId, partialContent, continuationCount }); setMessages(prev=>{ const u=[...prev]; if(u[messageIndex]) u[messageIndex]={...u[messageIndex],isTruncated:true}; return u }) }
    }
    streamingBubbleRef.current = null
    setIsContinuing(false); setAbortController(null)
    setTimeout(() => externalFocusRef.current?.(), 80)
  }, [truncated])

  function handleRetry() { if (currentError?.canRetry) { setShowError(false); setCurrentError(null); const lastUser=[...messagesRef.current].reverse().find(m=>m.role==='user'); if(lastUser) sendMessage(lastUser.content) } }

  // ==========================================================================
  // COMPUTED
  // ==========================================================================
  const filtered   = searchQ.trim() ? conversations.filter(c => c.title.toLowerCase().includes(searchQ.toLowerCase()) || c.messages.some(m => m.content.toLowerCase().includes(searchQ.toLowerCase()))) : conversations
  const grouped    = groupConversations(filtered)
  const activeConvo = conversations.find(c => c.id===activeId)
  const GROUP_LABELS = [t.today, t.yesterday, t.days7, t.thisMonth, t.older]

  // ==========================================================================
  // TRIAL EXPIRED MODAL
  // ==========================================================================
  function TrialExpiredModal() {
    const bg     = 'var(--surface)'
    const border = 'var(--border)'
    const sub    = 'var(--muted)'
    const itemBg = 'var(--surface2)'

    const isExpired  = trialStatus?.isExpired ?? true
    const pctLeft    = 100 - (trialStatus?.pctUsed ?? 100)
    const accentColor =
      isExpired    ? '#ef4444' :
      pctLeft <= 10 ? '#f97316' :
      pctLeft <= 25 ? '#eab308' :
      pctLeft <= 50 ? '#3b82f6' : '#22c55e'

    const barWidth = isExpired ? 0 : pctLeft

    return (
      <div style={{ position:'fixed', inset:0, zIndex:99996, background:'rgba(0,0,0,0.75)', backdropFilter:'blur(12px)', display:'flex', alignItems:'center', justifyContent:'center', padding:20, animation:'fadeIn 0.25s ease-out' }}>
        <div onClick={e => e.stopPropagation()} className="trial-modal-card" style={{ background:bg, border:`1px solid ${border}`, borderRadius:24, padding:'28px 24px 22px', maxWidth:420, width:'100%', boxShadow:'0 40px 120px rgba(0,0,0,0.6)', position:'relative', animation:'slideUpModal 0.3s cubic-bezier(0.34,1.4,0.64,1) both', maxHeight:'90dvh', overflowY:'auto' }}>
          <button onClick={() => setShowTrialExpired(false)}
            style={{ position:'absolute', top:14, right:14, width:28, height:28, borderRadius:8, background:itemBg, border:`1px solid ${border}`, color:sub, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none', transition:'all 0.2s' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor=accentColor)}
            onMouseLeave={e => (e.currentTarget.style.borderColor='var(--border)')}>
            <X size={13}/>
          </button>
          <div style={{ display:'flex', justifyContent:'center', marginBottom:16 }}>
            <div className="trial-modal-icon" style={{ width:56, height:56, borderRadius:'50%', background:`${accentColor}18`, border:`2px solid ${accentColor}55`, display:'flex', alignItems:'center', justifyContent:'center' }}>
              {isExpired ? <X size={24} color={accentColor}/> : <Clock size={24} color={accentColor}/>}
            </div>
          </div>
          <div style={{ textAlign:'center', marginBottom:16 }}>
            <div style={{ fontFamily:'Syne, sans-serif', fontWeight:900, fontSize:'1.05rem', color:'var(--text)', marginBottom:8, letterSpacing:'-0.02em' }}>
              {isExpired ? t.trialComingSoonTitle : t.trialQuotaTitle}
            </div>
            <p style={{ fontSize:'0.76rem', color:sub, lineHeight:1.65, margin:0 }}>
              {isExpired
                ? t.trialComingSoonSub
                : t.trialQuotaSub.replace('{pct}', String(pctLeft))}
            </p>
          </div>
          {!isExpired && (
            <div style={{ marginBottom:18 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                <span style={{ fontSize:'0.62rem', color:sub }}>{t.sheetKuotaLabel}</span>
                <span style={{ fontSize:'0.62rem', fontWeight:700, color:accentColor }}>{pctLeft}% tersisa</span>
              </div>
              <div style={{ height:8, borderRadius:99, background:'var(--surface2)', border:`1px solid ${border}`, overflow:'hidden' }}>
                <div style={{ height:'100%', width:`${barWidth}%`, background:accentColor, borderRadius:99, transition:'width 0.6s ease', boxShadow:`0 0 8px ${accentColor}60` }}/>
              </div>
              {trialStatus?.tokensUsed != null && trialStatus?.tokenQuota != null && (
                <div style={{ display:'flex', justifyContent:'space-between', marginTop:8 }}>
                  <div style={{ display:'flex', flexDirection:'column', gap:2 }}>
                    <span style={{ fontSize:'0.58rem', color:sub, opacity:0.6 }}>Terpakai</span>
                    <span style={{ fontSize:'0.78rem', fontWeight:700, fontFamily:'monospace', color:'var(--text)' }}>{(trialStatus.tokensUsed ?? 0).toLocaleString()}</span>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:2, alignItems:'center' }}>
                    <span style={{ fontSize:'0.58rem', color:sub, opacity:0.6 }}>Total</span>
                    <span style={{ fontSize:'0.78rem', fontWeight:700, fontFamily:'monospace', color:'var(--text)' }}>{(trialStatus.tokenQuota ?? 0).toLocaleString()}</span>
                  </div>
                  <div style={{ display:'flex', flexDirection:'column', gap:2, alignItems:'flex-end' }}>
                    <span style={{ fontSize:'0.58rem', color:sub, opacity:0.6 }}>Tersisa</span>
                    <span style={{ fontSize:'0.78rem', fontWeight:700, fontFamily:'monospace', color:accentColor }}>{(trialStatus.tokensLeft ?? 0).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          )}
          {(() => {
            const items: { icon: string; text: string }[] = isExpired
              ? [
                  { icon:'⚡', text: t.trialComingSoonItem1 },
                  { icon:'🔒', text: t.trialComingSoonItem2 },
                  { icon:'📧', text: t.trialComingSoonItem3 },
                ]
              : [
                  { icon:'💬', text: t.trialQuotaItem1 },
                  { icon:'⚡', text: t.trialQuotaItem2 },
                ]
            return (
              <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:18 }}>
                {items.map((item, i) => (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:9, padding:'8px 12px', background:itemBg, border:`1px solid ${border}`, borderRadius:9 }}>
                    <span style={{ fontSize:'0.88rem', flexShrink:0 }}>{item.icon}</span>
                    <span style={{ fontSize:'0.72rem', color:sub, lineHeight:1.45 }}>{item.text}</span>
                  </div>
                ))}
              </div>
            )
          })()}
          <button onClick={() => setShowTrialExpired(false)}
            style={{ width:'100%', padding:'11px', borderRadius:12, border:`1.5px solid ${accentColor}80`, background:'transparent', color:accentColor, fontFamily:'Syne, sans-serif', fontWeight:700, fontSize:'0.83rem', cursor:'pointer', transition:'all 0.2s', outline:'none' }}
            onMouseEnter={e => (e.currentTarget.style.background=`${accentColor}18`)}
            onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
            {isExpired ? t.trialComingSoonCta : t.trialQuotaCta}
          </button>
          {isExpired && (
            <p style={{ textAlign:'center', fontSize:'0.62rem', color:sub, marginTop:10, lineHeight:1.55, opacity:0.7 }}>
              {t.trialComingSoonFooter}
            </p>
          )}
        </div>
      </div>
    )
  }

  // ==========================================================================
  // SUB-COMPONENTS
  // ==========================================================================
  function DeleteModal() {
    if (!deleteModal) return null
    const titleDisplay = deleteModal.title.length > 40 ? deleteModal.title.slice(0,40)+'…' : deleteModal.title
    return (
      <div onClick={() => setDeleteModal(null)} style={{ position:'fixed',inset:0,zIndex:99997,background:'rgba(0,0,0,0.72)',backdropFilter:'blur(6px)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,animation:'fadeIn 0.2s ease-out' }}>
        <div onClick={e=>e.stopPropagation()} style={{ background:'var(--surface)',border:'1px solid var(--border)',borderRadius:18,padding:'28px 24px',maxWidth:380,width:'100%',boxShadow:'0 32px 80px rgba(0,0,0,0.6)',animation:'slideUpModal 0.25s cubic-bezier(0.34,1.56,0.64,1)',display:'flex',flexDirection:'column',alignItems:'center' }}>
          <div style={{ width:54,height:54,borderRadius:15,background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:18 }}><Trash2 size={24} color="#ef4444"/></div>
          <div style={{ fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:'1.08rem',color:'var(--text)',textAlign:'center',marginBottom:10 }}>{t.deleteTitle}</div>
          <div style={{ fontSize:'0.79rem',color:'var(--muted)',textAlign:'center',lineHeight:1.65,marginBottom:26,maxWidth:300 }}>
            <span style={{ color:'var(--text)',fontWeight:600,background:'var(--surface2)',padding:'2px 8px',borderRadius:6,fontSize:'0.75rem',fontStyle:'italic' }}>"{titleDisplay}"</span>{' '}{t.deleteDesc}
          </div>
          <div style={{ display:'flex',gap:10,width:'100%' }}>
            <button onClick={() => setDeleteModal(null)} style={{ flex:1,padding:'11px 0',background:'transparent',border:'1px solid var(--border)',borderRadius:11,cursor:'pointer',color:'var(--muted)',fontFamily:'inherit',fontSize:'0.83rem',fontWeight:500,transition:'all 0.2s',outline:'none' }} onMouseEnter={e=>{ (e.currentTarget.style.borderColor='var(--accent)');(e.currentTarget.style.color='var(--text)') }} onMouseLeave={e=>{ (e.currentTarget.style.borderColor='var(--border)');(e.currentTarget.style.color='var(--muted)') }}>{t.deleteCancelBtn}</button>
            <button onClick={confirmDelete} style={{ flex:1,padding:'11px 0',background:'#ef4444',border:'none',borderRadius:11,cursor:'pointer',color:'white',fontFamily:'inherit',fontSize:'0.83rem',fontWeight:700,transition:'all 0.2s',outline:'none',boxShadow:'0 4px 18px rgba(239,68,68,0.35)',display:'flex',alignItems:'center',justifyContent:'center',gap:7 }} onMouseEnter={e=>(e.currentTarget.style.opacity='0.88')} onMouseLeave={e=>(e.currentTarget.style.opacity='1')}><Trash2 size={14}/> {t.deleteConfirmBtn}</button>
          </div>
        </div>
      </div>
    )
  }

  function SkeletonChat() {
    const rows = [{ role:'user',widths:['55%'],delay:0 },{ role:'assistant',widths:['85%','70%','40%'],delay:0.1 },{ role:'user',widths:['45%'],delay:0.2 },{ role:'assistant',widths:['80%','60%'],delay:0.3 }]
    return (
      <div style={{ display:'flex',flexDirection:'column',gap:16,padding:'20px 0' }}>
        {rows.map((row,ri) => (
          <div key={ri} style={{ display:'flex',alignItems:'flex-start',gap:9,flexDirection:row.role==='user'?'row-reverse':'row',maxWidth:'76%',marginLeft:row.role==='user'?'auto':0 }}>
            <div className="skeleton-bar" style={{ width:30,height:30,borderRadius:9,flexShrink:0,animationDelay:`${row.delay}s` }}/>
            <div style={{ display:'flex',flexDirection:'column',gap:7,padding:'10px 14px',borderRadius:13,background:'var(--surface2)',border:'1px solid var(--border)',minWidth:120 }}>
              {row.widths.map((w,wi) => <div key={wi} className="skeleton-bar" style={{ height:11,width:w,borderRadius:6,animationDelay:`${row.delay+wi*0.05}s` }}/>)}
            </div>
          </div>
        ))}
      </div>
    )
  }

  // ==========================================================================
  // RENDER
  // ==========================================================================
  return (
    <div style={{ display:'flex',height:'100dvh',background:'var(--bg)',overflow:'hidden' }}>

      {(navProgress||isLoadingConversations||isLoadingMessages) && <div className="nav-loading-bar"/>}
      {showUpgrade && <TrialExpiredModal/>}
      {deleteModal && <DeleteModal/>}
      {showTrialExpired && <TrialExpiredModal/>}
      {showPaymentPopup && (
        <PaymentComingSoonPopup
          onClose={() => setShowPaymentPopup(false)}
          t={t}
        />
      )}

      {showQuotaResetPopup && (
        <QuotaResetPopup
          onClose={() => setShowQuotaResetPopup(false)}
          t={t}
          resetAt={trialStatus?.resetAt ?? null}
        />
      )}

      {/* Error Modal */}
      {showError && currentError && (
        <div onClick={() => { setShowError(false); setCurrentError(null) }} style={{ position:'fixed',inset:0,zIndex:10000,background:'rgba(0,0,0,0.72)',backdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',padding:20,animation:'fadeIn 0.2s ease-out' }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:'var(--surface)',border:'1px solid rgba(239,68,68,0.3)',borderRadius:20,padding:'32px 28px',maxWidth:400,width:'100%',boxShadow:'0 40px 120px rgba(0,0,0,0.6)',animation:'slideUpModal 0.3s cubic-bezier(0.34,1.56,0.64,1)',display:'flex',flexDirection:'column',alignItems:'center' }}>
            <div style={{ width:60,height:60,borderRadius:18,background:'rgba(239,68,68,0.1)',border:'1px solid rgba(239,68,68,0.25)',display:'flex',alignItems:'center',justifyContent:'center',marginBottom:20 }}><span style={{ fontSize:'1.75rem' }}>⚠️</span></div>
            <div style={{ fontFamily:'Syne,sans-serif',fontWeight:800,fontSize:'1.1rem',color:'var(--text)',marginBottom:10,textAlign:'center' }}>{t.errorTitle}</div>
            <div style={{ fontSize:'0.82rem',color:'var(--muted)',lineHeight:1.7,textAlign:'center',marginBottom:26,maxWidth:320 }}>{currentError.message}</div>
            <div style={{ display:'flex',flexDirection:'column',gap:10,width:'100%' }}>
              {currentError.canRetry && <button onClick={handleRetry} style={{ display:'flex',alignItems:'center',justifyContent:'center',gap:8,background:'var(--accent)',border:'none',borderRadius:12,color:'var(--send-color)',fontFamily:'inherit',fontSize:'0.88rem',fontWeight:700,padding:'13px 20px',cursor:'pointer',transition:'all 0.2s' }} onMouseEnter={e=>(e.currentTarget.style.opacity='0.88')} onMouseLeave={e=>(e.currentTarget.style.opacity='1')}><RotateCcw size={15}/> {t.retry}</button>}
              <button onClick={() => { setShowError(false); setCurrentError(null) }} style={{ background:'transparent',border:'1px solid var(--border)',color:'var(--muted)',fontFamily:'inherit',fontSize:'0.78rem',padding:'10px 20px',borderRadius:12,cursor:'pointer',transition:'all 0.2s' }} onMouseEnter={e=>{ (e.currentTarget.style.borderColor='var(--accent)');(e.currentTarget.style.color='var(--text)') }} onMouseLeave={e=>{ (e.currentTarget.style.borderColor='var(--border)');(e.currentTarget.style.color='var(--muted)') }}>{t.dismiss}</button>
            </div>
          </div>
        </div>
      )}

      {sidebarOpen && <div onClick={()=>setSidebarOpen(false)} style={{ position:'fixed',inset:0,background:'rgba(0,0,0,0.6)',backdropFilter:'blur(3px)',zIndex:998 }}/>}

      {/* Sidebar Desktop */}
      <aside className="sidebar-desktop" style={{ width:272,minWidth:272,background:'var(--surface)',borderRight:'1px solid var(--border)',padding:'20px 14px',flexShrink:0,display:'flex',flexDirection:'column',transition:'background 0.35s' }}>
        <Sidebar
          t={t} conversations={conversations} activeId={activeId}
          searchQ={searchQ} setSearchQ={setSearchQ} filtered={filtered}
          grouped={grouped} GROUP_LABELS={GROUP_LABELS}
          isSidebarLoading={isSidebarLoading}
          startNewChat={startNewChat} openConvo={openConvo}
          handleDelete={handleDelete}
          activeMessages={messages}
        />
      </aside>
      {/* Sidebar Mobile */}
      <aside className="sidebar-mobile" style={{ position:'fixed',top:0,left:0,bottom:0,width:288,background:'var(--surface)',borderRight:'1px solid var(--border)',padding:'20px 14px',zIndex:999,transform:sidebarOpen?'translateX(0)':'translateX(-100%)',transition:'transform 0.3s cubic-bezier(0.4,0,0.2,1), background 0.35s',boxShadow:sidebarOpen?'12px 0 50px rgba(0,0,0,0.5)':'none',display:'flex',flexDirection:'column' }}>
        <Sidebar
          t={t} conversations={conversations} activeId={activeId}
          searchQ={searchQ} setSearchQ={setSearchQ} filtered={filtered}
          grouped={grouped} GROUP_LABELS={GROUP_LABELS}
          isSidebarLoading={isSidebarLoading}
          startNewChat={startNewChat} openConvo={openConvo}
          handleDelete={handleDelete}
          activeMessages={messages}
        />
      </aside>

      <main style={{ flex:1,display:'flex',flexDirection:'column',overflow:'hidden',minWidth:0,position:'relative' }}>

        {/* HEADER */}
        <AppNavbar
          leftSlot={
            <div style={{ display:'flex', alignItems:'center', gap:10, flex:1, minWidth:0 }}>
              <button className="hamburger-btn" onClick={()=>setSidebarOpen(o=>!o)}
                style={{ display:'none', alignItems:'center', justifyContent:'center', width:34, height:34, background:'var(--surface2)', border:'1px solid var(--border)', borderRadius:9, cursor:'pointer', flexShrink:0 }}>
                {sidebarOpen ? <X size={15} color="var(--text)"/> : <Menu size={15} color="var(--text)"/>}
              </button>
              <div style={{ fontFamily:'Syne,sans-serif', fontWeight:700, fontSize:'0.95rem', letterSpacing:'-0.01em', whiteSpace:'nowrap' }}>{BRAND.name}</div>
            </div>
          }
          userName={userName}
          userEmail={userEmail}
          userImage={userImage}
          onLogout={handleLogout}
        />

        {/* BREADCRUMB + TRIAL BANNER */}
        <div style={{ display:'flex',alignItems:'center',gap:8,padding:'5px 22px',borderBottom:'1px solid var(--border)',background:'var(--surface)',flexShrink:0,fontSize:'0.62rem',color:'var(--muted)',transition:'background 0.35s, border-color 0.35s',minHeight:28 }}>
          <MessageSquare size={10} color="var(--accent)" style={{ flexShrink:0 }}/>
          <span style={{ color:'var(--text)',fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1,minWidth:0 }}>{activeConvo?.title ?? (activeId ? t.convFallbackTitle : t.newChat)}</span>

          <span className="breadcrumb-desktop-only" style={{ display:'contents' }}>
            <span style={{ opacity:0.35,flexShrink:0 }}>·</span>
            <span style={{ flexShrink:0 }}>{messages.length} {t.messages}</span>
          </span>

          {/* Gauge indikator kuota */}
          {false && trialStatus?.isFree && (() => {
            const pctLeft  = Math.max(0, 100 - (trialStatus?.pctUsed ?? 100))
            const isOut    = trialStatus?.isExpired || pctLeft <= 0
            const segments = 8
            const filled   = isOut ? 0 : Math.round((pctLeft / 100) * segments)
            const color    =
              isOut         ? '#ef4444' :
              pctLeft <= 10 ? '#f97316' :
              pctLeft <= 30 ? '#eab308' :
              pctLeft <= 60 ? '#3b82f6' : '#22c55e'
            return (
              <div style={{ display:'flex', alignItems:'center', gap:5, flexShrink:0 }}>
                <div style={{ display:'flex', alignItems:'center', gap:1.5, padding:'2px 3px', borderRadius:4, border:`1px solid ${color}60`, background:`${color}10` }}>
                  {Array.from({ length: segments }).map((_, i) => (
                    <div key={i} style={{
                      width:4, height:10, borderRadius:1.5,
                      background: i < filled ? color : `${color}22`,
                      transition:'background 0.3s',
                    }}/>
                  ))}
                  <div style={{ width:2, height:5, borderRadius:'0 1px 1px 0', background:`${color}80`, marginLeft:1, flexShrink:0 }}/>
                </div>
                <span style={{ fontSize:'0.58rem', fontWeight:700, color, fontVariantNumeric:'tabular-nums', letterSpacing:'-0.01em' }}>
                  {isOut ? '0%' : `${pctLeft}%`}
                </span>
              </div>
            )
          })()}

          {/* Badge kuota habis */}
          {trialStatus && (trialStatus.isExpired || (trialStatus.tokensLeft !== null && trialStatus.tokensLeft <= 0)) && (
            <>
              <span className="breadcrumb-desktop-only" style={{ display:'contents' }}>
                <span style={{ opacity:0.35,flexShrink:0 }}>·</span>
                <button onClick={() => setShowQuotaResetPopup(true)} style={{ display:'inline-flex',alignItems:'center',gap:4,fontSize:'0.6rem',fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444450',padding:'2px 8px',borderRadius:20,cursor:'pointer',fontFamily:'inherit',outline:'none',flexShrink:0,whiteSpace:'nowrap',transition:'all 0.2s' }}>
                  {t.trialBadgeExpired}
                </button>
            </span>
            <span className="trial-badge-mobile">
              <button onClick={() => setShowQuotaResetPopup(true)} style={{ display:'inline-flex',alignItems:'center',gap:4,fontSize:'0.6rem',fontWeight:700,color:'#ef4444',background:'#ef444418',border:'1px solid #ef444450',padding:'2px 8px',borderRadius:20,cursor:'pointer',fontFamily:'inherit',outline:'none',flexShrink:0,whiteSpace:'nowrap',transition:'all 0.2s' }}>
                  {t.trialBadgeExpired}
                </button>
              </span>
            </>
          )}
        </div>

        {/* CHAT AREA */}
        <div ref={chatAreaRef} style={{ flex:1, overflowY:'auto', padding:'36px 24px', display:'flex', flexDirection:'column', alignItems:'center', position:'relative' }}>
          <div className="chat-inner-wrapper" style={{ maxWidth:780, width:'100%', display:'flex', flexDirection:'column', gap:14, flex:1 }}>

            {isChatLoading ? <SkeletonChat/> : messages.length===0 ? (
              <div style={{ flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:18,minHeight:'85vh',userSelect:'none' }}>
                <div style={{ opacity:0.18 }}><Bot size={54} color="var(--text)"/></div>
                <div style={{ textAlign:'center' }}>
                  <div style={{ fontFamily:'Syne,sans-serif',fontWeight:700,fontSize:'1.35rem',opacity:0.5,marginBottom:8 }}>{BRAND.name}</div>
                  <div style={{ fontSize:'0.77rem',color:'var(--muted)',lineHeight:1.7,opacity:0.7 }}>
                    {(conversations.length>0?t.orSelectOld:t.startChat).split('\n').map((l,i)=><span key={i}>{l}{i===0&&<br/>}</span>)}
                  </div>
                </div>
                <div style={{ width:'100%', maxWidth:580 }}>
                  {/* <div style={{ fontSize:'0.62rem', letterSpacing:'0.1em', textTransform:'uppercase', color:'var(--muted)', opacity:0.5, textAlign:'center', marginBottom:12 }}>
                    Pilih topik untuk memulai
                  </div> */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill, minmax(132px, 1fr))', gap:8 }}>
                    {t.suggestions.map(s => {
                      const [icon, label, prompt] = s.split('|')
                      return (
                        <button
                          key={s}
                          onClick={() => sendMessage(prompt ?? s)}
                          style={{
                            display:'flex', flexDirection:'column', alignItems:'flex-start',
                            gap:6, padding:'12px 13px',
                            background:'var(--surface2)', border:'1px solid var(--border)',
                            borderRadius:13, cursor:'pointer', transition:'all 0.2s',
                            textAlign:'left', outline:'none',
                          }}
                          onMouseEnter={e => {
                            const el = e.currentTarget as HTMLElement
                            el.style.borderColor = 'var(--accent)'
                            el.style.background = 'color-mix(in srgb, var(--accent) 6%, var(--surface2))'
                            el.style.transform = 'translateY(-2px)'
                            el.style.boxShadow = '0 4px 16px rgba(0,0,0,0.15)'
                          }}
                          onMouseLeave={e => {
                            const el = e.currentTarget as HTMLElement
                            el.style.borderColor = 'var(--border)'
                            el.style.background = 'var(--surface2)'
                            el.style.transform = 'translateY(0)'
                            el.style.boxShadow = 'none'
                          }}
                        >
                          <span style={{ fontSize:'1.25rem', lineHeight:1 }}>{icon}</span>
                          <span style={{
                            fontSize:'0.75rem', fontWeight:600,
                            color:'var(--text)', fontFamily:'Syne, sans-serif',
                            lineHeight:1.3,
                          }}>
                            {label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>
            ) : null}

            {!isChatLoading && messages.map((msg, i) => {
              const isLast   = i===messages.length-1
              const isStream = (isStreaming||isContinuing) && isLast && msg.role==='assistant'
              const isTyping = isStream && msg.content===''
              const isErr    = !!(msg as any).isError && msg.role === 'assistant'
              const canRetry = isErr && (msg as any).canRetry === true
              const isTrunc  = !!(msg as any).isTruncated
              const messageId = `${msg.role}-${msg.timestamp}-${i}`
              const isCopied  = copiedId===messageId
              const isPlaying = audioState.isPlaying && audioState.currentMessageId===messageId
              const isThisContinuing = isContinuing && truncated===null && isLast && msg.role==='assistant'
              return (
                <div key={i}>
                  <div className={msg.role==='user' ? 'chat-message-user' : 'chat-message-assistant'} style={{ display:'flex',alignItems:'flex-start',gap:9,flexDirection:msg.role==='user'?'row-reverse':'row',maxWidth:'100%',marginLeft:msg.role==='user'?'auto':0 }}>
                    {/* Avatar */}
                    <div className="bubble-avatar" style={{ flexShrink:0 }}>
                      {msg.role==='user' ? (
                        <UserAvatar image={userImage} name={userName} size={30} fontSize={12} borderRadius={9}/>
                      ) : (
                        <div style={{ width:30,height:30,borderRadius:9,display:'flex',alignItems:'center',justifyContent:'center',background:isErr?'rgba(239,68,68,0.1)':'transparent',border:isErr?'1px solid rgba(239,68,68,0.3)':'1px solid var(--border)',color:isErr?'#ef4444':'var(--accent)',transition:'background 0.35s' }}>
                          <Bot size={14}/>
                        </div>
                      )}
                    </div>

                    {isErr ? (
                      <div className="bubble-content" style={{ display:'flex',flexDirection:'column',gap:8 }}>
                        <div style={{ display:'flex',alignItems:'flex-start',gap:9,padding:'10px 14px',borderRadius:13,borderBottomLeftRadius:3,background:'rgba(239,68,68,0.06)',border:'1px solid rgba(239,68,68,0.2)',fontSize:'0.84rem',lineHeight:1.65,color:'var(--text)' }}>
                          <span style={{ fontSize:'1rem',flexShrink:0,marginTop:1 }}>😔</span><span>{msg.content}</span>
                        </div>
                        {canRetry && (
                          <button onClick={() => { const prevUser=[...messages].reverse().find(m=>m.role==='user'); if(prevUser){ setMessages(prev=>prev.filter((_,idx)=>idx<i-1)); setInputFromOutside(prevUser.content) } }} style={{ alignSelf:'flex-start',display:'flex',alignItems:'center',gap:5,background:'transparent',border:'1px solid var(--border)',color:'var(--muted)',fontFamily:'inherit',fontSize:'0.71rem',padding:'5px 12px',borderRadius:20,cursor:'pointer',transition:'all 0.2s' }} onMouseEnter={e=>{ (e.currentTarget as HTMLElement).style.borderColor='var(--accent)';(e.currentTarget as HTMLElement).style.color='var(--accent)' }} onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.borderColor='var(--border)';(e.currentTarget as HTMLElement).style.color='var(--muted)' }}>
                            <RotateCcw size={10}/> {t.retry}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="bubble-content">
                        <div className="bubble" data-role={msg.role} style={{ padding:'10px 14px',borderRadius:16,fontSize:'0.86rem',lineHeight:1.68,background:msg.role==='user'?'var(--user-bubble)':'var(--ai-bubble)',color:msg.role==='user'?'var(--user-bubble-text)':'var(--ai-bubble-text)',border:msg.role==='user'?'1px solid var(--user-border)':isTrunc?'1px solid rgba(249,115,22,0.35)':'1px solid var(--border)',borderBottomRightRadius:msg.role==='user'?4:16,borderBottomLeftRadius:msg.role==='assistant'?4:16,transition:'background 0.35s, border-color 0.35s, color 0.35s',maskImage:isTrunc?'linear-gradient(to bottom, black 80%, transparent 100%)':undefined,WebkitMaskImage:isTrunc?'linear-gradient(to bottom, black 80%, transparent 100%)':undefined }}>
                          {isTyping ? (
                            <div style={{ display:'flex',gap:5,alignItems:'center',padding:'2px 0' }}><div className="typing-dot"/><div className="typing-dot"/><div className="typing-dot"/></div>
                          ) : isStream ? (
                            <><span ref={isLast ? streamingBubbleRef : undefined} dangerouslySetInnerHTML={{ __html:renderMd(msg.content) }}/><span className="stream-cursor">▌</span></>
                          ) : (
                            <span dangerouslySetInnerHTML={{ __html:renderMd(msg.content) }}/>
                          )}
                          {(msg.searchUsed || (msg.sources && msg.sources.length > 0)) && !isStream && (
                            <div style={{ marginTop:10, paddingTop:9, borderTop:'1px solid var(--border)', display:'flex', flexDirection:'column', gap:4 }}>
                              {/* Label status */}
                              <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:'0.65rem', color:'var(--muted)', opacity:0.75 }}>
                                <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
                                  <circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/>
                                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                                </svg>
                                <span>{t.webSearch}</span>
                              </div>
                              {/* Daftar sumber */}
                              {msg.sources && msg.sources.length > 0 && (
                                <div style={{ display:'flex', flexDirection:'column', gap:3, marginTop:2 }}>
                                  {msg.sources.map((src, si) => (
                                    <a key={si} href={src.url} target="_blank" rel="noreferrer"
                                      style={{ display:'flex', alignItems:'center', gap:5, fontSize:'0.65rem', color:'var(--text)', textDecoration:'underline', textDecorationColor:'var(--border)', textUnderlineOffset:'3px', opacity:0.7, transition:'opacity 0.15s', overflow:'hidden', whiteSpace:'nowrap' }}
                                      onMouseEnter={e => { e.currentTarget.style.opacity='1'; e.currentTarget.style.textDecorationColor='var(--muted)' }}
                                      onMouseLeave={e => { e.currentTarget.style.opacity='0.7'; e.currentTarget.style.textDecorationColor='var(--border)' }}>
                                      <img src={`https://www.google.com/s2/favicons?domain=${new URL(src.url).hostname}&sz=16`} width={11} height={11} style={{ flexShrink:0, borderRadius:2, opacity:0.8 }} onError={e => { (e.target as HTMLImageElement).style.display='none' }}/>
                                      <span style={{ overflow:'hidden', textOverflow:'ellipsis' }}>
                                        {src.title ? `${src.title} — ` : ''}{src.url}
                                      </span>
                                    </a>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {!isStream && msg.timestamp && msg.role === 'assistant' && (
                            <div style={{ marginTop:8, paddingTop:7, borderTop:'1px solid var(--border)', fontSize:'0.58rem', color:'var(--muted)', opacity:0.45, textAlign:'right', userSelect:'none' }}>
                              {new Date(msg.timestamp).toLocaleString(undefined, { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })}
                            </div>
                          )}
                        </div>
                        {isTrunc && !isBusy && (
                          <div style={{ display:'flex',alignItems:'center',gap:10,marginTop:8,padding:'10px 14px',background:'rgba(249,115,22,0.06)',border:'1px solid rgba(249,115,22,0.25)',borderRadius:12,animation:'fadeIn 0.3s ease-out' }}>
                            <div style={{ display:'flex',alignItems:'center',gap:6,flex:1,minWidth:0 }}>
                              <div style={{ width:6,height:6,borderRadius:'50%',background:'#f97316',flexShrink:0,boxShadow:'0 0 6px #f97316' }}/>
                              <span style={{ fontSize:'0.7rem',color:'#f97316',fontWeight:500 }}>{t.truncatedNotice}</span>
                            </div>
                            <button onClick={continueResponse} style={{ display:'flex',alignItems:'center',gap:6,flexShrink:0,background:'var(--accent)',border:'none',color:'var(--send-color)',fontFamily:'inherit',fontSize:'0.72rem',fontWeight:600,padding:'7px 14px',borderRadius:20,cursor:'pointer',transition:'all 0.2s',boxShadow:'0 2px 12px rgba(249,115,22,0.3)' }} onMouseEnter={e=>(e.currentTarget.style.opacity='0.85')} onMouseLeave={e=>(e.currentTarget.style.opacity='1')}>
                              <ChevronRight size={13}/> {t.continueBtnLabel}
                            </button>
                          </div>
                        )}
                        {isThisContinuing && (
                          <div style={{ display:'flex',alignItems:'center',gap:8,marginTop:8,padding:'8px 14px',background:'rgba(249,115,22,0.06)',border:'1px solid rgba(249,115,22,0.2)',borderRadius:12 }}>
                            <Loader2 size={12} color="#f97316" style={{ animation:'spin 1s linear infinite',flexShrink:0 }}/>
                            <span style={{ fontSize:'0.7rem',color:'#f97316' }}>{t.continuingLabel}</span>
                          </div>
                        )}
                        {!isTyping && !isStream && !isTrunc && (
                          <div style={{ display:'flex',alignItems:'center',gap:6,marginTop:6,justifyContent:msg.role==='user'?'flex-end':'flex-start',padding:'0 4px',flexWrap:'wrap' }}>
                            {msg.timestamp && <span style={{ fontSize:'0.6rem',color:'var(--muted)',opacity:0.45,marginRight:2,userSelect:'none' }}>{formatMsgTime(msg.timestamp)}</span>}
                            <button onClick={() => copyToClipboard(msg.content,messageId)} style={{ display:'flex',alignItems:'center',gap:4,background:'transparent',border:'none',color:isCopied?'#22c55e':'var(--muted)',fontSize:'0.65rem',cursor:'pointer',padding:'4px 8px',borderRadius:12,transition:'all 0.2s' }} onMouseEnter={e=>{ if(!isCopied)(e.currentTarget as HTMLElement).style.background='var(--surface2)' }} onMouseLeave={e=>{ if(!isCopied)(e.currentTarget as HTMLElement).style.background='transparent' }}>
                              <Copy size={16}/>
                            </button>
                            <button onClick={() => speakText(msg.content,messageId)} style={{ display:'flex',alignItems:'center',gap:4,background:'transparent',border:'none',color:isPlaying?'var(--accent)':'var(--muted)',fontSize:'0.65rem',cursor:'pointer',padding:'4px 8px',borderRadius:12,transition:'all 0.2s' }} onMouseEnter={e=>{ if(!isPlaying)(e.currentTarget as HTMLElement).style.background='var(--surface2)' }} onMouseLeave={e=>{ if(!isPlaying)(e.currentTarget as HTMLElement).style.background='transparent' }}>
                              {isPlaying?<VolumeX size={11}/>:<Volume2 size={16}/>}
                            </button>
                            {msg.role==='assistant' && !isStream && (
                              <button onClick={() => {
                                const text = msg.content
                                if (navigator.share) { navigator.share({ text }).catch(() => {}) }
                                else { copyToClipboard(text, messageId + '-share') }
                              }} style={{ display:'flex',alignItems:'center',gap:4,background:'transparent',border:'none',color:'var(--muted)',fontSize:'0.65rem',cursor:'pointer',padding:'4px 8px',borderRadius:12,transition:'all 0.2s' }} onMouseEnter={e=>{ (e.currentTarget as HTMLElement).style.background='var(--surface2)' }} onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background='transparent' }} title={t.share}>
                                <Share2 size={16}/>
                              </button>
                            )}
                            {msg.role==='user' && isLast && !isBusy && (
                              <button
                                onClick={async () => {
                                  setMessages(prev => {
                                    const last = prev[prev.length - 1]
                                    if (last?.role === 'assistant') return prev.slice(0, -1)
                                    return prev
                                  })
                                  await sendMessage(msg.content, true)
                                }}
                                style={{ display:'flex',alignItems:'center',gap:4,background:'transparent',border:'none',color:'var(--muted)',fontSize:'0.65rem',cursor:'pointer',padding:'4px 8px',borderRadius:12,transition:'all 0.2s' }}
                                onMouseEnter={e=>{ (e.currentTarget as HTMLElement).style.background='var(--surface2)';(e.currentTarget as HTMLElement).style.color='var(--accent)' }}
                                onMouseLeave={e=>{ (e.currentTarget as HTMLElement).style.background='transparent';(e.currentTarget as HTMLElement).style.color='var(--muted)' }}
                              >
                                <RotateCcw size={11}/><span>{t.retry}</span>
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

            <div ref={endRef}/>
          </div>
        </div>

        {/* Scroll to Bottom Button */}
        {showScrollDown && (() => {
          const rect = chatAreaRef.current?.getBoundingClientRect()
          const centerX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2
          return (
            <div
              className="scroll-down-wrapper"
              style={{
                position: 'fixed',
                bottom: scrollBtnBottom,
                left: centerX - 19,
                zIndex: 50,
                pointerEvents: 'none',
                animation: 'fadeIn 0.2s ease-out',
              }}
            >
              <button
                onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth' })}
                style={{
                  pointerEvents: 'auto',
                  width: 38,
                  height: 38,
                  borderRadius: '50%',
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--accent)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 18px rgba(0,0,0,0.35)',
                  transition: 'background 0.2s, color 0.2s',
                  outline: 'none',
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--accent)'
                  ;(e.currentTarget as HTMLElement).style.color = 'var(--send-color)'
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLElement).style.background = 'var(--surface)'
                  ;(e.currentTarget as HTMLElement).style.color = 'var(--accent)'
                }}
                title="Scroll ke bawah"
              >
                <ChevronDown size={18} />
              </button>
            </div>
          )
        })()}
        
        {/* Data Canvas Panel */}
        {(showSheetAnalyzer || showDataCanvas || showScraper || showFormBuilder || showLocationAgent || showDriveExplorer) && (
          <div style={{ flexShrink:0, borderTop:'1px solid var(--border)', background:'var(--surface)', maxHeight:'45dvh', display:'flex', flexDirection:'column', maxWidth:780, width:'100%', margin:'0 auto' }}>
            {/* Tab bar — hanya muncul di panel data analisis */}
            {(showSheetAnalyzer || showDataCanvas) && (
              <div style={{ display:'flex', borderBottom:'1px solid var(--border)', flexShrink:0, overflowX:'auto', scrollbarWidth:'none', msOverflowStyle:'none', maxWidth:780, width:'100%', margin:'0 auto' }}>
                <button
                  onClick={() => { setShowSheetAnalyzer(true); setShowDataCanvas(false) }}
                  style={{ flexShrink:0, padding:'8px 14px', fontSize:'0.68rem', fontWeight:600, fontFamily:'inherit', background:'transparent', border:'none', borderBottom: showSheetAnalyzer ? '2px solid var(--accent)' : '2px solid transparent', color: showSheetAnalyzer ? 'var(--accent)' : 'var(--muted)', cursor:'pointer', outline:'none', display:'flex', alignItems:'center', gap:5, transition:'all 0.15s', whiteSpace:'nowrap' }}>
                  <FileSpreadsheet size={11}/> {t.sheetTitle}
                </button>
                <button
                  onClick={() => { setShowDataCanvas(true); setShowSheetAnalyzer(false) }}
                  style={{ flexShrink:0, padding:'8px 14px', fontSize:'0.68rem', fontWeight:600, fontFamily:'inherit', background:'transparent', border:'none', borderBottom: showDataCanvas ? '2px solid var(--accent)' : '2px solid transparent', color: showDataCanvas ? 'var(--accent)' : 'var(--muted)', cursor:'pointer', outline:'none', display:'flex', alignItems:'center', gap:5, transition:'all 0.15s', whiteSpace:'nowrap' }}>
                  <Database size={11}/> {t.dcTitle}
                </button>
                <div style={{ flex:1 }}/>
                <button
                  onClick={() => { setShowSheetAnalyzer(false); setShowDataCanvas(false) }}
                  style={{ flexShrink:0, width:36, background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none' }}>
                  <X size={12}/>
                </button>
              </div>
            )}

            {/* Web Scraper header */}
            {showScraper && (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 14px', borderBottom:'1px solid var(--border)', flexShrink:0, maxWidth:780, width:'100%', margin:'0 auto' }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <Globe size={11} color="var(--accent)"/>
                  <span style={{ fontSize:'0.68rem', fontWeight:600, color:'var(--accent)' }}>{t.scraperTitle}</span>
                </div>
                <button
                  onClick={() => setShowScraper(false)}
                  style={{ background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none', width:36 }}>
                  <X size={12}/>
                </button>
              </div>
            )}

            {/* Location Agent header */}
            {showLocationAgent && (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 14px', borderBottom:'1px solid var(--border)', flexShrink:0, maxWidth:780, width:'100%', margin:'0 auto' }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <MapPin size={11} color="#f59e0b"/>
                  <span style={{ fontSize:'0.68rem', fontWeight:600, color:'#f59e0b' }}>Location Agent</span>
                </div>
                <button
                  onClick={() => setShowLocationAgent(false)}
                  style={{ background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none', width:36 }}>
                  <X size={12}/>
                </button>
              </div>
            )}

            {showDriveExplorer && (
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 14px', borderBottom:'1px solid var(--border)', flexShrink:0, maxWidth:780, width:'100%', margin:'0 auto' }}>
                <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <FolderOpen size={11} color="#4ade80"/>
                  <span style={{ fontSize:'0.68rem', fontWeight:600, color:'#4ade80' }}>Drive Explorer</span>
                </div>
                <button
                  onClick={() => setShowDriveExplorer(false)}
                  style={{ background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', outline:'none', width:36 }}>
                  <X size={12}/>
                </button>
              </div>
            )}

            {/*showDriveExplorer && (
              <GoogleDriveAgent onClose={() => setShowDriveExplorer(false)} language={activeLangRef.current === 'id' ? 'Indonesia' : 'English'}
                  onInsight={(text, url, title) => {
                    sendMessage(`Berikut struktur folder Google Drive "${title}":\n\n${text}`, true)
                    setShowDriveExplorer(false)
                  }}
              />
            )*/}

            {/* Content — lebar ikut maxWidth kolom chat */}
            <div style={{ flex:1, overflowY:'auto', minHeight:0, width:'100%', maxWidth:780, margin:'0 auto', alignSelf:'stretch', boxSizing:'border-box' }}>
              {showSheetAnalyzer && (
                <SheetAnalyzer
                  userId={session?.user?.email ?? ''}
                  onClose={() => { setShowSheetAnalyzer(false); setShowDataCanvas(false) }}
                  t={t}
                  convId={activeId ?? undefined}
                  onCanvasSaved={(id) => {
                    fetch(`/api/datacanvas?action=get&id=${id}`)
                      .then(r => r.json())
                      .then(d => { if (d.canvas) setActiveCanvas(d.canvas) })
                      .catch(() => {})
                  }}
                />
              )}
              {showDataCanvas && (
                <DataCanvasPanel
                  onClose={() => { setShowSheetAnalyzer(false); setShowDataCanvas(false) }}
                  activeCanvasId={activeCanvas?.id}
                  t={t}
                  onUseInChat={(canvas) => {
                    setActiveCanvas(canvas)
                    setShowDataCanvas(false)
                    if (activeId) {
                      fetch('/api/datacanvas', {
                        method:'POST',
                        headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ action:'link', canvasId:canvas.id, convId:activeId }),
                      }).catch(() => {})
                    }
                  }}
                />
              )}
              {showScraper && (
                <WebScraperAgent
                  onClose={() => setShowScraper(false)}
                  language={activeLangRef.current === 'id' ? 'Indonesia' : 'English'}
                  t={t}
                  onInsight={(text, url, title) => {
                    sendMessage(`Berikut hasil analisis dari ${title} (${url}):\n\n${text}`, true)
                    setShowScraper(false)
                  }}
                />
              )}
              {showFormBuilder && (
                <FormBuilderAgent
                  onClose={() => setShowFormBuilder(false)}
                  userId={session?.user?.email ?? ''}
                  username={session?.user?.name?.toLowerCase().replace(/\s+/g, '') ?? 'user'}
                  baseUrl={process.env.NEXT_PUBLIC_BASE_URL ?? 'https://conversa2026.vercel.app'}
                  t={t}
                  onFormSaved={(schema) => {
                    // Notifikasi ke chat bahwa form sudah tersimpan
                    console.log('Form saved:', schema.slug)
                  }}
                  onSendToChat={(summary) => {
                    sendMessage(summary, true)
                    setShowFormBuilder(false)
                  }}
                />
              )}

              {showLocationAgent && (
                <LocationAgent
                  onClose={() => {
                    setShowLocationAgent(false)
                    setLocationAutoQuery(null)
                  }}
                  language={activeLangRef.current === 'id' ? 'Indonesia' : 'English'}
                  t={t as unknown as Record<string, unknown>}
                  autoQuery={locationAutoQuery ?? undefined}
                  onInsight={(text, query, title) => {
                    sendMessage(text, true)
                    setShowLocationAgent(false)
                    setLocationAutoQuery(null)
                  }}
                />
              )}
              
              {showDriveExplorer && (
                <GoogleDriveAgent
                  onClose={() => setShowDriveExplorer(false)}
                  language={activeLangRef.current === 'id' ? 'Indonesia' : 'English'}
                  onInsight={(text, url, title) => {
                    sendMessage(`Berikut struktur folder Google Drive "${title}":\n\n${text}`, true)
                    setShowDriveExplorer(false)
                  }}
                />
              )}
            </div>
          </div>
        )}

        {/* Active Canvas Banner */}
        {activeCanvas && !showDataCanvas && (
          <div style={{ flexShrink:0 }}>
            <div style={{ maxWidth:780, width:'100%', margin:'0 auto', padding:'0 12px' }}>
              <div style={{ margin:'6px 0 0', padding:'6px 12px', background:'color-mix(in srgb, var(--accent) 8%, var(--surface2))', border:'1px solid color-mix(in srgb, var(--accent) 30%, var(--border))', borderRadius:9, display:'flex', alignItems:'center', gap:8 }}>
                <Database size={11} color="var(--accent)"/>
                <span style={{ fontSize:'0.68rem', color:'var(--text)', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  Konteks: <strong>{activeCanvas.title}</strong>
                </span>
                <button onClick={() => setActiveCanvas(null)}
                  style={{ background:'transparent', border:'none', color:'var(--muted)', cursor:'pointer', padding:0, display:'flex', outline:'none' }}>
                  <X size={11}/>
                </button>
              </div>
            </div>
          </div>
        )}

        <ChatInput
          onSend={sendMessage} onStop={stopStreaming}
          isStreaming={isStreaming||isContinuing} isGenerating={false} disabled={isBusy || !!(trialStatus?.isExpired)}
          placeholder={t.typeMessage} placeholderBusy={t.typeMessage}
          hintEnter={t.aiDisclaimer} hintShift={t.shiftNewline}
          externalSetInput={(setter) => { externalSetInputRef.current = setter }}
          externalFocus={(fn) => { externalFocusRef.current = fn }}
          group={selectedGroup}
          onGroupChange={(g: ModelGroupKey) => { setSelectedGroup(g); selectedGroupRef.current=g; localStorage.setItem('conversaSelectedGroup',g) }}
          t={t}
          showUpgradeBadge={!!(trialStatus?.isFree)}
          onUpgradeClick={() => { setShowPaymentPopup(true) }}
          onSheetAnalyzer={() => {
            const isOpen = showSheetAnalyzer || showDataCanvas
            if (isOpen) { setShowSheetAnalyzer(false); setShowDataCanvas(false) }
            else {
              setShowSheetAnalyzer(true)
              setShowDataCanvas(false)
              setShowScraper(false)
              setShowLocationAgent(false)
              setShowDriveExplorer(false)
            }
          }}
          sheetAnalyzerActive={showSheetAnalyzer || showDataCanvas}
          onDataCanvas={() => {}}
          dataCanvasActive={false}
          onScraper={() => {
            if (showScraper) { setShowScraper(false) }
            else {
              setShowScraper(true)
              setShowSheetAnalyzer(false)
              setShowDataCanvas(false)
              setShowLocationAgent(false)
              setShowDriveExplorer(false)
            }
          }}
          scraperActive={showScraper}
          onFormBuilder={() => { router.push('/formbuilder') }}
          formBuilderActive={false}
          onSlideGenerator={() => { router.push('/slide-generator') }}
          pastedArtifacts={pastedArtifacts}
          onAddArtifact={(a) => { setPastedArtifacts(prev => [...prev, a]); artifactCounter.current += 1 }}
          onRemoveArtifact={(id) => setPastedArtifacts(prev => prev.filter(a => a.id !== id))}
          onPreviewArtifact={(a) => setPreviewArtifact(a)}
          artifactCounter={artifactCounter.current}
          onLocationAgent={() => {
            if (showLocationAgent) { setShowLocationAgent(false) }
            else {
              setShowLocationAgent(true)
              setShowScraper(false)
              setShowSheetAnalyzer(false)
              setShowDataCanvas(false)
              setShowFormBuilder(false)
              setShowDriveExplorer(false)
            }
          }}
          locationAgentActive={showLocationAgent}
          imageAttachments={imageAttachments}
          onAddImage={addImageAttachment}
          onRemoveImage={(id) => setImageAttachments(prev => prev.filter(a => a.id !== id))}
          isMobile={isMobileView}
          onDriveExplorer={() => {
            if (showDriveExplorer) { setShowDriveExplorer(false) }
            else {
              setShowDriveExplorer(true)
              setShowScraper(false)
              setShowSheetAnalyzer(false)
              setShowDataCanvas(false)
              setShowLocationAgent(false)
              setShowFormBuilder(false)
            }
          }}
          driveExplorerActive={showDriveExplorer}
        />
      </main>

      <audio ref={audioRef} style={{ display:'none' }}/>

      <ArtifactPreviewPanel
        artifact={previewArtifact}
        onClose={() => setPreviewArtifact(null)}
        isMobile={isMobileView}
      />

      <style>{`
        @keyframes spin { from{transform:rotate(0deg)} to{transform:rotate(360deg)} }
        @keyframes fadeIn { from{opacity:0} to{opacity:1} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes cursorBlink { 0%,100%{opacity:1} 45%{opacity:1} 55%{opacity:0} }
        @keyframes tokenFadeIn { from{opacity:0;filter:blur(2px)} to{opacity:1;filter:blur(0)} }
        @keyframes slideUpModal { from{opacity:0;transform:translateY(30px) scale(0.95)} to{opacity:1;transform:translateY(0) scale(1)} }
        @keyframes shimmer { 0%{background-position:-600px 0} 100%{background-position:600px 0} }
        @media (max-width: 640px) {
          .scroll-down-wrapper {
            left: auto !important;
            right: 24px !important;
          }
        }
        .stream-cursor { display:inline-block;color:var(--accent);animation:cursorBlink 0.6s step-end infinite;font-weight:400;margin-left:1px;line-height:1; }
        .bubble { word-break: break-word; overflow-wrap: anywhere; }
        .bubble pre { white-space: pre-wrap; overflow-x: auto; word-break: break-all; }
        .bubble code { word-break: break-all; }
        .skeleton-bar { background:linear-gradient(90deg,var(--surface2) 0%,var(--border) 40%,var(--surface2) 60%,var(--surface2) 100%);background-size:600px 100%;animation:shimmer 1.6s ease-in-out infinite; }

        .chat-message-user .bubble-content,
        .chat-message-assistant .bubble-content {
          max-width: 76%;
        }

        @media (max-width: 640px) {
          .bubble-avatar { display: none !important; }
          .chat-message-user .bubble-content,
          .chat-message-assistant .bubble-content { max-width: 100% !important; }
          .chat-message-user,
          .chat-message-assistant { gap: 0 !important; }
          .chat-inner-wrapper { max-width: 100% !important; }
        }

        .trial-badge-mobile { display: none; }
        @media (max-width: 640px) {
          .trial-badge-mobile { display: inline-flex; margin-left: auto; }
          .breadcrumb-desktop-only { display: none !important; }
          .trial-modal-card { padding: 20px 16px 16px !important; border-radius: 18px !important; }
          .trial-modal-icon { width: 44px !important; height: 44px !important; }
        }

        [data-theme="coral"] {
          --bg:#1a2e2c; --surface:#1f3533; --surface2:#243d3a;
          --border:#2a9d8f40; --text:#e8f5f3; --muted:#7ab8b2;
          --accent:#2a9d8f; --send-color:#fff;
          --user-bubble:#e9c46a; --user-bubble-text:#1a2e2c; --user-border:#f4a26160;
          --ai-bubble:#1f3533; --ai-bubble-text:#e8f5f3;
        }
        [data-theme="carnival"] {
          --bg:#0d1b2a; --surface:#112236; --surface2:#162b42;
          --border:#1982c440; --text:#f0f4f8; --muted:#6da8d4;
          --accent:#1982c4; --send-color:#fff;
          --user-bubble:#ffca3a; --user-bubble-text:#0d1b2a; --user-border:#ff595e60;
          --ai-bubble:#112236; --ai-bubble-text:#f0f4f8;
        }
        [data-theme="nordic"] {
          --bg:#fdfcdc; --surface:#f7f6c8; --surface2:#eef0c0;
          --border:#00afb940; --text:#0d3b44; --muted:#0081a7;
          --accent:#0081a7; --send-color:#fff;
          --user-bubble:#00afb9; --user-bubble-text:#fdfcdc; --user-border:#0081a760;
          --ai-bubble:#f7f6c8; --ai-bubble-text:#0d3b44;
        }
        @keyframes artifactFadeIn {
          from { opacity: 0; transform: scale(0.92); }
          to   { opacity: 1; transform: scale(1); }
        }
        .artifact-chip { animation: artifactFadeIn 0.22s cubic-bezier(0.34,1.4,0.64,1); }

        /* AI Agents mobile/desktop visibility */
        .desktop-agent-btn { display: flex !important; }
        .mobile-agent-toggle { display: none !important; }

        @media (max-width: 640px) {
          .desktop-agent-btn { display: none !important; }
          .mobile-agent-toggle { display: flex !important; }
        }

        @media (max-width: 640px) {
          .camera-btn-mobile { display: flex !important; }
        }
      `}</style>
    </div>
  )
}
