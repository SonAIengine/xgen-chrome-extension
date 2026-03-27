import { useState, useEffect, useCallback } from 'react';
import { STORAGE_KEYS, API_PROVIDERS_ENDPOINT } from '../../shared/constants';

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

        // Auto-select if current provider/model is empty
        if (!model) {
          const current = list.find((p) => p.provider === provider && p.available);
          if (current?.default_model) {
            setModel(current.default_model);
            chrome.storage.local.set({ [STORAGE_KEYS.MODEL]: current.default_model });
          }
        }
      }
    } catch {
      // Server not reachable
    } finally {
      setLoading(false);
    }
  }, [provider, model]);

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

  const currentProvider = providers.find((p) => p.provider === provider);
  const availableProviders = providers.filter((p) => p.available);
  const displayName = currentProvider?.name || provider;

  return (
    <div className="border-b border-gray-200">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-gray-500 hover:text-gray-700 transition-colors"
      >
        <span className="truncate">
          {displayName} · {model || '(모델 미설정)'}
        </span>
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {expanded && (
        <div className="px-3 pb-2.5 space-y-2">
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

          <div className="text-[10px] text-gray-400 truncate pt-0.5">
            {serverUrl
              ? serverUrl.replace(/^https?:\/\//, '')
              : loading ? '서버 감지 중...' : 'XGEN 페이지를 열면 자동 감지'}
          </div>
        </div>
      )}
    </div>
  );
}
