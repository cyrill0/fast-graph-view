import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig(
	globalIgnores([
		"node_modules",
		"dist",
		"main.js",
		"src/generated",
		"test-vault",
		"tools",
		"esbuild.config.mjs",
		"tests/run.mjs",
	]),
	...obsidianmd.configs.recommendedWithLocalesEn,
	{
		files: ["tests/**/*.test.ts"],
		rules: {
			// These files are executed by Node's test runner, not shipped inside Obsidian.
			"obsidianmd/no-nodejs-modules": "off",
			"obsidianmd/no-global-this": "off",
		},
	},
	{
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.node,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						"eslint.config.mjs",
						"manifest.json",
					],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: [".json"],
			},
		},
		rules: {
			// Add custom brand names or acronyms here so the UI sentence-case rule doesn't flag them
			"obsidianmd/ui/sentence-case": [
				"warn",
				{
					brands: ["Obsidian", "GitHub"],
				},
			],
			// Each tooltip line is a separate imperative, so retain its two-line capitalization.
			"obsidianmd/ui/sentence-case-locale-module": [
				"warn",
				{
					brands: ["Obsidian", "GitHub"],
					ignoreRegex: ["^Click to change color\\nDrag to reorder groups$"],
				},
			],
		},
	}
);
