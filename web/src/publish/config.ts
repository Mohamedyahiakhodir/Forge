import { bridge } from '../native';
import { effective } from '../settings';

export const L = (ar: string, en: string): string => (effective().lang === 'ar' ? ar : en);

/** Play requires new apps/updates to target a recent API level; keep this in one place. */
export const TARGET_SDK = 36;

export interface PublishConfig {
  appName: string;
  packageId: string;
  versionName: string;
  versionCode: number;
  source: 'local' | 'url';
  entryFile: string;
  url: string;
  orientation: 'unspecified' | 'portrait' | 'landscape';
  themeColor: string;
  iconPath: string;
  privacyUrl: string;
  internet: boolean;
  vibrate: boolean;
  camera: boolean;
  microphone: boolean;
  location: boolean;
  notifications: boolean;
  push: boolean;
  nativeActions: boolean;
  oauth: boolean;
  oauthScheme: string;
  googleClientId: string;
  googleSignIn: boolean;
  playSha1: string;
  playSha256: string;
}

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/^[0-9]+/, '') || 'app';

export function defaults(projectPath: string): PublishConfig {
  const project = projectPath.split('/').filter(Boolean).pop() ?? projectPath; // device projects are full paths
  return {
    appName: project.slice(0, 30),
    packageId: `com.yourname.${slug(project)}`,
    versionName: '1.0.0',
    versionCode: 1,
    source: 'local',
    entryFile: 'index.html',
    url: '',
    orientation: 'unspecified',
    themeColor: '#1e88e5',
    iconPath: '',
    privacyUrl: '',
    internet: true,
    vibrate: false,
    camera: false,
    microphone: false,
    location: false,
    notifications: false,
    push: false,
    nativeActions: true,
    oauth: false,
    oauthScheme: `com.yourname.${slug(project)}`,
    googleClientId: '',
    googleSignIn: false,
    playSha1: '',
    playSha256: '',
  };
}

const file = (project: string) => `${project}/.forge/publish.json`;

export function loadConfig(project: string): PublishConfig {
  const d = defaults(project);
  try {
    if (bridge.stat(file(project)).exists) return { ...d, ...JSON.parse(bridge.readText(file(project))) };
  } catch { /* corrupt file: start from defaults */ }
  return d;
}

export function saveConfig(project: string, cfg: PublishConfig): void {
  try { bridge.writeText(file(project), JSON.stringify(cfg, null, 2) + '\n'); } catch { /* shown by caller on generate */ }
}
