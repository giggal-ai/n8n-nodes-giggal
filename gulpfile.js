const path = require('path');
const { task, src, dest } = require('gulp');

// n8n loads icons from paths relative to the compiled node file. The TS
// compiler doesn't copy .svg files, so this gulp task mirrors them into
// dist/ preserving the same folder shape.
task('build:icons', copyIcons);

function copyIcons() {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg}');
	const nodeDestination = path.resolve('dist', 'nodes');

	src(nodeSource).pipe(dest(nodeDestination));

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');

	return src(credSource).pipe(dest(credDestination));
}
