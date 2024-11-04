import monacoVersion from './monaco-editor/package.json' assert { type: 'json' };

export * from './monaco-editor'

// // Setup Monaco workers
// self.MonacoEnvironment = {
//   getWorkerUrl: (moduleId, label) => {
//     if (label === 'typescript' || label === 'javascript') {
//       return `./monaco-${monacoVersion}/typescript.worker.js`
//     }
//     return `./monaco-${monacoVersion}/editor.worker.js`
//   }
// }

import 'monaco-editor/esm/vs/editor/editor.api';
export * from './monaco-editor'

self.MonacoEnvironment ??= {};

self.MonacoEnvironment.getWorker = (workerId, label) => {
		const getWorkerModule = (moduleUrl, label) => {
      if (!self.MonacoEnvironment?.getWorkerUrl) {
        throw new Error('getWorkerUrl is not defined');
      }

			return new Worker(self.MonacoEnvironment.getWorkerUrl(moduleUrl, label), {
				name: label,
				type: 'module'        
			});
		};

		switch (label) {
			case 'json':
				return getWorkerModule('./monaco-editor/esm/vs/language/json/json.worker?worker', label);
			case 'css':
			case 'scss':
			case 'less':
				return getWorkerModule('./monaco-editor/esm/vs/language/css/css.worker?worker', label);
			case 'html':
			case 'handlebars':
			case 'razor':
				return getWorkerModule('./monaco-editor/esm/vs/language/html/html.worker?worker', label);
			case 'typescript':
			case 'javascript':
				return getWorkerModule('./monaco-editor/esm/vs/language/typescript/ts.worker?worker', label);
			default:
				return getWorkerModule('./monaco-editor/esm/vs/editor/editor.worker?worker', label);
		}
	};