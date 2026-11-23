import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import './styles.css';

// Automated snapshot tests can ask for every confirm() to be accepted (see LASER_CONFIRM)
if (new URLSearchParams(location.search).get('autoconfirm') === '1') window.confirm = () => true;

createRoot(document.getElementById('root')!).render(<App />);
