// TODO publish to definitely typed? https://www.typescriptlang.org/docs/handbook/declaration-files/templates/module-d-ts.html
declare module 'webpack-shebang-plugin' {
	export default class ShebangPlugin {
		constructor(configuration?: {
			/**
			 * optional, you can specify a different regular expression here for your own pattern.
			 * the pattern below is used by default, if unset.
			 *
			 * /[\s\n\r]*(#!.*)[\s\n\r]*\/gm
			 *
			 * It matches syntax like:
			 *      #!........
			 *
			 * The regular expression should contain a group of the main shebang part as $1, in the above case,
			 * the shebang part "#!........" will be grouped out.
			 * * If you create one of your own, you should keep sure that the main part will be grouped out as $1,
			 *   and it will be used as your shebang.
			 * * If you are not sure how to write your regular expression, please just leave it unset.
			 */
			shebangRegExp?: RegExp,
			/**
			 * optional, you can specify r/w/e permissions in octal value.
			 * The default value is 0o755, which makes the output bundle executable.
			 * You can set the value to 0, if you want to keep the default permissions.
			 */
			chmod?: number,
		})

		apply: (compiler: Compiler) => void;
	}
}