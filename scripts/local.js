// Always private, even if the environment contains a different DRY_RUN value.
process.env.DRY_RUN = 'true';
process.env.MOCK_APIS = 'false';
const {safeError,readJSON} = await import('../src/util.js');
try {
 const config = await readJSON('config.json');
 const {provider} = await import('../src/provider.js');
 provider(config,'llm');
 provider(config,'image');
 const {prepare} = await import('../src/main.js');
 console.log(JSON.stringify(await prepare({config}),null,2));
} catch (error) {console.error(safeError(error));process.exitCode=1;}
