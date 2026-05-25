const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const unusedImports = require("eslint-plugin-unused-imports");

module.exports = [
    {
        files: ["**/*.ts", "**/*.js"],
        ignores: ["node_modules", "dist"],

        languageOptions: {
            parser: tsParser,
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module"
            }
        },

        plugins: {
            "@typescript-eslint": tsPlugin,
            "unused-imports": unusedImports // ✅ THIS WAS MISSING
        },

        rules: {
            "semi": ["error", "always"],
            "indent": ["error", 2], // or 4 if you prefer
            "quotes": ["error", "double"],

            // 🔥 spacing rules
            "no-trailing-spaces": "error",
            "eol-last": ["error", "always"],
            "no-multiple-empty-lines": ["error", { max: 1 }],
            "space-infix-ops": "error",
            "space-before-blocks": "error",
            "keyword-spacing": ["error", { before: true, after: true }],
            "object-curly-spacing": ["error", "always"],
            "array-bracket-spacing": ["error", "never"],

            // unused cleanup (already added)
            "no-unused-vars": "off",
            "@typescript-eslint/no-unused-vars": "off",
            "unused-imports/no-unused-imports": "error",
            "unused-imports/no-unused-vars": [
                "warn",
                {
                    vars: "all",
                    varsIgnorePattern: "^_",
                    args: "after-used",
                    argsIgnorePattern: "^_"
                }
            ]
        }
    }
];