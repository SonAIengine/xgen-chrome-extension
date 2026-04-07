import { useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS, API_PROVIDERS_ENDPOINT, DEFAULT_SERVER_URL } from '../../shared/constants';

interface ProviderInfo {
  provider: string;
  name: string;
  models: string[];
  default_model: string;
  available: boolean;
}

export function SettingsBar() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [serverUrlInput, setServerUrlInput] = useState('');
  const [editingUrl, setEditingUrl] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);

  // Load saved settings + fetch providers
  useEffect(() => {
    chrome.storage.local.get(
      [STORAGE_KEYS.PROVIDER, STORAGE_KEYS.MODEL, STORAGE_KEYS.SERVER_URL, STORAGE_KEYS.AUTH_TOKEN],
      (result) => {
        const savedProvider = result[STORAGE_KEYS.PROVIDER] || 'anthropic';
        const savedModel = result[STORAGE_KEYS.MODEL] || '';
        const savedUrl = result[STORAGE_KEYS.SERVER_URL] || '';

        setProvider(savedProvider);
        setModel(savedModel);
        setServerUrl(savedUrl);

        if (savedUrl) {
          fetchProviders(savedUrl, result[STORAGE_KEYS.AUTH_TOKEN] || '');
        }
      },
    );
  }, []);

  // Re-fetch when server URL changes
  useEffect(() => {
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[STORAGE_KEYS.SERVER_URL]?.newValue) {
        const newUrl = changes[STORAGE_KEYS.SERVER_URL].newValue;
        setServerUrl(newUrl);
        chrome.storage.local.get(STORAGE_KEYS.AUTH_TOKEN, (r) => {
          fetchProviders(newUrl, r[STORAGE_KEYS.AUTH_TOKEN] || '');
        });
      }
    };
    chrome.storage.local.onChanged.addListener(listener);
    return () => chrome.storage.local.onChanged.removeListener(listener);
  }, []);

  const fetchProviders = useCallback(async (url: string, token: string) => {
    setLoading(true);
    try {
      const resp = await fetch(`${url}${API_PROVIDERS_ENDPOINT}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (resp.ok) {
        const data = await resp.json();
        const list: ProviderInfo[] = data.providers || [];
        setProviders(list);
        // 모델 auto-select 하지 않음 — 사용자가 provider 변경할 때만 model 변경
      }
    } catch {
      // Server not reachable
    } finally {
      setLoading(false);
    }
  }, []);

  const handleProviderChange = useCallback((newProvider: string) => {
    setProvider(newProvider);
    const info = providers.find((p) => p.provider === newProvider);
    const newModel = info?.default_model || '';
    setModel(newModel);
    chrome.storage.local.set({
      [STORAGE_KEYS.PROVIDER]: newProvider,
      [STORAGE_KEYS.MODEL]: newModel,
    });
  }, [providers]);

  const handleModelChange = useCallback((newModel: string) => {
    setModel(newModel);
    chrome.storage.local.set({ [STORAGE_KEYS.MODEL]: newModel });
  }, []);

  const handleServerUrlSave = useCallback(() => {
    const trimmed = serverUrlInput.trim().replace(/\/+$/, '');
    if (trimmed) {
      setServerUrl(trimmed);
      chrome.storage.local.set({ [STORAGE_KEYS.SERVER_URL]: trimmed });
    }
    setEditingUrl(false);
  }, [serverUrlInput]);

  const currentProvider = providers.find((p) => p.provider === provider);
  const availableProviders = providers.filter((p) => p.available);
  const displayName = currentProvider?.name || provider;

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`p-1 rounded transition-colors ${expanded ? 'text-gray-700 bg-gray-100' : 'text-gray-400 hover:text-gray-600'}`}
        title={`${displayName} · ${model || '(모델 미설정)'}`}
      >
        {/* Settings gear icon */}
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {expanded && (
        <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-50 p-2.5 space-y-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Provider
            </label>
            <select
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
            >
              {availableProviders.length > 0
                ? availableProviders.map((p) => (
                    <option key={p.provider} value={p.provider}>{p.name}</option>
                  ))
                : <option value={provider}>{displayName}</option>
              }
            </select>
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Model
            </label>
            {currentProvider && currentProvider.models.length > 0 ? (
              <select
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
              >
                {currentProvider.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={(e) => handleModelChange(e.target.value)}
                placeholder="모델 ID"
                className="w-full text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
              />
            )}
          </div>

          <div>
            <label className="block text-[10px] uppercase tracking-wide text-gray-400 mb-1">
              Server URL
            </label>
            {editingUrl ? (
              <div className="flex gap-1">
                <input
                  type="text"
                  value={serverUrlInput}
                  onChange={(e) => setServerUrlInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleServerUrlSave(); if (e.key === 'Escape') setEditingUrl(false); }}
                  placeholder={DEFAULT_SERVER_URL}
                  className="flex-1 text-xs rounded border border-gray-200 bg-white text-gray-700 px-2 py-1.5 focus:outline-none focus:border-gray-400"
                  autoFocus
                />
                <button
                  onClick={handleServerUrlSave}
                  className="text-xs px-1.5 py-1 rounded bg-gray-100 hover:bg-gray-200 text-gray-600"
                >
                  ✓
                </button>
              </div>
            ) : (
              <div
                onClick={() => { setServerUrlInput(serverUrl || DEFAULT_SERVER_URL); setEditingUrl(true); }}
                className="text-xs text-gray-500 truncate cursor-pointer hover:text-gray-700 px-2 py-1.5 rounded border border-transparent hover:border-gray-200"
                title="클릭하여 서버 URL 변경"
              >
                {serverUrl
                  ? serverUrl.replace(/^https?:\/\//, '')
                  : loading ? '서버 감지 중...' : '클릭하여 서버 URL 설정'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
