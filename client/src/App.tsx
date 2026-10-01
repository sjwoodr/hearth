import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api.ts';
import { ChatApp } from './ChatApp.tsx';
import { Login } from './Login.tsx';

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api.me().then(setMe, (err) => {
      if (err instanceof ApiError && err.status === 401) setMe(null);
      else throw err;
    });
  }, []);

  if (me === undefined) return null;
  if (me === null) return <Login onSignedIn={setMe} />;
  return <ChatApp me={me} onSignedOut={() => setMe(null)} />;
}
