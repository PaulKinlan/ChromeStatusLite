onload = async () => {
  const url = new URL(location);
  let loadedVersion = url.searchParams.get("version");

  const versionEl = document.getElementById("version");
  const versions = await getVersions();

  if (loadedVersion == null) {
    loadedVersion = versions[0]; // default to the latest
    history.pushState({}, undefined, `/?version=${loadedVersion}`);
  }

  

  versionEl.onchange = async (event) => {
    event.form.submit();
  };
};