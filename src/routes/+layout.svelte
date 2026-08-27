<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>stignore</title>
	<link
		rel="icon"
		href={'data:image/svg+xml,' +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
					'<rect width="32" height="32" rx="7" fill="#020617"/>' +
					'<circle cx="16" cy="16" r="9" fill="none" stroke="#22d3ee" stroke-width="2.5"/>' +
					'<line x1="9" y1="23" x2="23" y2="9" stroke="#22d3ee" stroke-width="2.5" stroke-linecap="round"/>' +
					'</svg>'
			)}
		type="image/svg+xml"
	/>
	<style>
		:global(html) {
			background-color: #020617;
			color-scheme: dark;
		}
		::-webkit-scrollbar {
			width: 10px;
			height: 10px;
		}
		::-webkit-scrollbar-track {
			background: #020617;
		}
		::-webkit-scrollbar-thumb {
			background: #334155;
			border-radius: 5px;
			border: 2px solid #020617;
		}
		::-webkit-scrollbar-thumb:hover {
			background: #22d3ee;
		}
	</style>
</svelte:head>

{@render children()}
