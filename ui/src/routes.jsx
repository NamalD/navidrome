import React from 'react'
import { Route } from 'react-router-dom'
import Personal from './personal/Personal'
import Downloader from './downloader/Downloader'
import config from './config'

const routes = [
  <Route exact path="/personal" render={() => <Personal />} key={'personal'} />,
  config.enableDownloader && (
    <Route
      exact
      path="/downloader"
      render={() => <Downloader />}
      key={'downloader'}
    />
  ),
].filter(Boolean)

export default routes
