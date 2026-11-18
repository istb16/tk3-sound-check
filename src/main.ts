import { mount } from 'svelte';
// tk3 apps 共通の土台を、アプリの全体の CSS より先に読み込む
import './shell/tk-base.css';
import './shell/app.css';
import App from './App.svelte';

const target = document.getElementById('app');
if (!target) throw new Error('#app element not found');

const app = mount(App, { target });
export default app;
