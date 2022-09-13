onload = async () => {
  const url = new URL(location);
  let version = url.searchParams.get("version");

  if (version == null || version == undefined) {
    location.search = `?version=106`;
  }

  const versionEl = document.getElementById("version");
  versionEl.onchange = async (event) => {
    event.target.form.submit();
  };
};