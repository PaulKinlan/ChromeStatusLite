onload = async () => {
  const url = new URL(location);
  let loadedVersion = url.searchParams.get("version");

  const versionEl = document.getElementById("version");
  versionEl.onchange = async (event) => {
    event.form.submit();
  };
};