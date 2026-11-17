import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Prevent third-party browser extensions from throwing when assigning to a getter-only window.fetch
try {
  const fetchDesc =
    Object.getOwnPropertyDescriptor(window, 'fetch') ||
    Object.getOwnPropertyDescriptor(Window.prototype, 'fetch');
  if (fetchDesc && fetchDesc.get && !fetchDesc.set) {
    const currentFetch = window.fetch.bind(window);
    Object.defineProperty(window, 'fetch', {
      value: currentFetch,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
} catch {
  // Ignore if host environment forbids redefining window.fetch
}

createRoot(document.getElementById('root')!).render(<App />);
