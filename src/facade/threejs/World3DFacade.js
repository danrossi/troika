import {assign, assignIf} from '../../utils'
import {WebGLRenderer, Raycaster, Color, Vector3} from 'three'
import WorldBaseFacade from '../WorldBaseFacade'
import Scene3DFacade from './Scene3DFacade'
import {PerspectiveCamera3DFacade} from './Camera3DFacade'
import {BoundingSphereOctree} from './BoundingSphereOctree'
import {extendAsVrCamera} from './vr/VrCamera'
import {VrControllerManager} from './vr/VrControllerManager'


const posVec = new Vector3()
const raycaster = new Raycaster()
const emptyArray = []


class World3DFacade extends WorldBaseFacade {
  constructor(canvas) {
    super(canvas)
    this._object3DFacadesById = Object.create(null)
    this._onBgClick = this._onBgClick.bind(this)
    this._hadVrDisplay = false
  }

  afterUpdate() {
    let {camera, width, height, antialias, backgroundColor} = this

    // Set up renderer
    let renderer = this._threeRenderer
    const RendererClass = this.rendererClass || WebGLRenderer
    if (!renderer || !(renderer instanceof RendererClass)) {
      if (renderer) {
        renderer.dispose()
      }
      renderer = this._threeRenderer = new RendererClass(assign({
        canvas: this._element,
        alpha: true,
        antialias: antialias
      }))
    }
    renderer.shadowMap.enabled = !!this.shadows
    if (backgroundColor !== this._bgColor) {
      this._threeRenderer.setClearColor(new Color(backgroundColor || 0), backgroundColor != null ? 1 : 0)
      this._bgColor = backgroundColor
    }

    // Set up camera
    camera.key = 'camera'
    camera.facade = camera.facade || PerspectiveCamera3DFacade
    if (typeof camera.aspect !== 'number') {
      camera.aspect = width / height
    }

    // Set up scene
    const scene = {
      key: 'scene',
      facade: Scene3DFacade,
      lights: this.lights,
      objects: this.objects,
      fog: this.fog,
      onClick: this.onBackgroundClick ? this._onBgClick : null
    }

    const vrDisplay = this._isInVR() ? this.vrDisplay : null
    if (vrDisplay) {
      // Wrap configured camera with VR camera decorator
      camera = assignIf({
        facade: extendAsVrCamera(camera.facade),
        vrDisplay
      }, camera)

      // Add VR controllers manager to scene
      scene.objects = emptyArray.concat(scene.objects, {
        key: 'vrcontrollers',
        facade: VrControllerManager,
        vrDisplay: vrDisplay
      })
    }
    if (!!vrDisplay !== this._hadVrDisplay) {
      this._togglePointerListeners(!vrDisplay)
      this._hadVrDisplay = !!vrDisplay
    }

    this.children = [camera, scene]

    // Update render canvas size
    let pixelRatio
    if (vrDisplay) {
      const leftEye = vrDisplay.getEyeParameters('left')
      const rightEye = vrDisplay.getEyeParameters('right')
      width = Math.max(leftEye.renderWidth, rightEye.renderWidth) * 2
      height = Math.max(leftEye.renderHeight, rightEye.renderHeight)
      pixelRatio = 1
    } else {
      pixelRatio = this.pixelRatio || window.devicePixelRatio || 1
    }
    let lastSize = renderer.getSize()
    if (lastSize.width !== width || lastSize.height !== height || renderer.getPixelRatio() !== pixelRatio) {
      renderer.setDrawingBufferSize(width, height, pixelRatio)
    }

    super.afterUpdate()
  }

  doRender() {
    let sceneFacade = this.getChildByKey('scene')
    let scene = sceneFacade.threeObject
    let camera = this.getChildByKey('camera').threeObject
    let renderer = this._threeRenderer

    // Invoke any onBeforeRender listeners
    let registry = this.eventRegistry
    function invokeHandler(handler) {
      handler(renderer, scene, camera)
    }
    registry.forEachListenerOfType('beforerender', invokeHandler, this)

    // Render scene
    renderer.render(scene, camera)

    // Invoke any onAfterRender listeners
    registry.forEachListenerOfType('afterrender', invokeHandler, this)

    // Submit VR frame
    if (this._isInVR()) {
      this.vrDisplay.submitFrame()
    }

    let onStatsUpdate = this.onStatsUpdate
    if (onStatsUpdate) {
      let info = renderer.info.render
      onStatsUpdate({
        'WebGL Draw Calls': info.calls,
        'WebGL Vertices': info.vertices,
        'WebGL Triangles': info.faces
      })
    }
  }

  _isInVR() {
    return !!(this.vrDisplay && this.vrDisplay.isPresenting)
  }

  _isContinuousRender() {
    return this.continuousRender || this._isInVR()
  }

  /**
   * @override to use an active WebVR device's scheduler when appropriate
   */
  _requestRenderFrame(callback) {
    return (this._isInVR() ? this.vrDisplay : window).requestAnimationFrame(callback)
  }

  /**
   * @override to use an active WebVR device's scheduler when appropriate
   */
  _cancelAnimationFrame(frameId) {
    return (this._isInVR() ? this.vrDisplay : window).cancelAnimationFrame(frameId)
  }

  /**
   * Implementation of abstract
   */
  getFacadeUserSpaceXYZ(facade) {
    let matrixEls = facade.threeObject.matrixWorld.elements
    return this.projectWorldPosition(matrixEls[12], matrixEls[13], matrixEls[14])
  }

  _doRenderHtmlItems() {
    if (this._isInVR()) {
      // Html overlays are useless in VR, so don't render them
      if (this.renderHtmlItems) {
        this.renderHtmlItems(emptyArray)
      }
    } else {
      super._doRenderHtmlItems()
    }
  }

  projectWorldPosition(x, y, z) {
    posVec.set(x, y, z)
    let camera = this.getChildByKey('camera')
    camera.updateMatrices()
    camera = camera.threeObject

    // Make position relative to camera
    posVec.applyMatrix4(camera.matrixWorldInverse)

    // Get relative distance to the point, negative if it's behind the camera
    let signedDistance = posVec.length() * (posVec.z > 0 ? -1 : 1)

    // Project x/y to screen coords
    posVec.applyMatrix4(camera.projectionMatrix)
    let screenX = (posVec.x + 1) * this.width / 2
    let screenY = (1 - posVec.y) * this.height / 2

    return new Vector3(screenX, screenY, signedDistance)
  }


  /**
   * @override to handle ray events e.g. from a vr controller
   */
  getFacadesAtEvent(e) {
    if (e.isRayEvent) {
      return e.ray ? this.getFacadesOnRay(e.ray) : null
    } else {
      return super.getFacadesAtEvent(e)
    }
  }

  /**
   * Implementation of abstract
   */
  getFacadesAtPosition(clientX, clientY, canvasRect) {
    // convert mouse position to normalized device coords (-1 to 1)
    let width = canvasRect.width || this.width //use logical size if no visible rect, e.g. offscreen canvas
    let height = canvasRect.height || this.height
    let u = (clientX - (canvasRect.left || 0)) / width * 2 - 1
    let v = (clientY - (canvasRect.top || 0)) / height * -2 + 1

    // ensure camera's matrix is updated
    let camera = this.getChildByKey('camera')
    camera.updateMatrices()

    // calculate the ray and use it to find intersecting facades
    let ray = camera.getRayAtProjectedCoords(u, v)
    return ray ? this.getFacadesOnRay(ray) : null
  }

  getFacadesOnRay(ray) {
    // update bounding sphere octree
    const octree = this._updateOctree()

    // search bounding sphere octree to quickly filter down to a small set of likely hits,
    // then do a true raycast on those facades
    let allHits = null
    if (octree) {
      raycaster.ray = ray
      octree.forEachSphereOnRay(ray, (sphere, facadeId) => {
        const facadesById = this._object3DFacadesById
        const facade = facadesById && facadesById[facadeId]
        const hits = facade && facade.raycast && facade.raycast(raycaster)
        if (hits && hits[0]) {
          // Ignore all but closest
          hits[0].facade = facade
          ;(allHits || (allHits = [])).push(hits[0])
        }
      })
    }
    return allHits
  }

  _updateOctree() {
    // update octree with any new bounding spheres
    let octree = this._boundingSphereOctree
    const changes = this._octreeChangeset
    if (changes) {
      if (!octree) {
        octree = this._boundingSphereOctree = new BoundingSphereOctree()
      }
      const {remove, put} = changes
      if (remove) {
        for (let facadeId in remove) {
          octree.removeSphere(facadeId)
        }
      }
      if (put) {
        for (let facadeId in put) {
          // Check for put requests for objects that are now obsolete
          const facade = this._object3DFacadesById[facadeId]
          if (facade && !facade.isDestroying && !(remove && remove[facadeId])) {
            const sphere = facade.getBoundingSphere && facade.getBoundingSphere()
            if (sphere) {
              octree.putSphere(facadeId, sphere)
            } else {
              octree.removeSphere(facadeId)
            }
          }
        }
      }
      this._octreeChangeset = null
    }
    return octree
  }

  _queueForOctreeChange(changeType, facade) {
    const changes = this._octreeChangeset || (this._octreeChangeset = {})
    const map = changes[changeType] || (changes[changeType] = Object.create(null))
    map[facade.$facadeId] = facade
  }

  _onBgClick(e) {
    // Ignore clicks that bubbled up
    if (e.target === e.currentTarget) {
      this.onBackgroundClick(e)
    }
  }

  destructor() {
    super.destructor()
    this._threeRenderer.dispose()
    this._threeRenderer.forceContextLoss()
  }

}



World3DFacade.prototype._notifyWorldHandlers = assign(
  Object.create(WorldBaseFacade.prototype._notifyWorldHandlers),
  {
    getCameraPosition(source, data) {
      data.callback(this.getChildByKey('camera').threeObject.position)
    },
    getCameraFacade(source, data) {
      data.callback(this.getChildByKey('camera'))
    },
    projectWorldPosition(source, data) {
      let pos = data.worldPosition
      data.callback(this.projectWorldPosition(pos.x, pos.y, pos.z))
    },
    object3DAdded(source) {
      this._object3DFacadesById[source.$facadeId] = source
      this._queueForOctreeChange('put', source)
    },
    object3DBoundsChanged(source) {
      this._queueForOctreeChange('put', source)
    },
    object3DRemoved(source) {
      delete this._object3DFacadesById[source.$facadeId]
      this._queueForOctreeChange('remove', source)
    },
    pointerRayMotion(source, ray) {
      // Dispatch a custom event carrying the Ray, which will be used by our `getFacadesAtEvent`
      // override to search for a hovered facade
      const e = new MouseEvent('mousemove')
      e.isRayEvent = true
      e.ray = ray
      this._onPointerMotionEvent(e)
    },
    pointerRayAction(source, eventParams) {
      // Dispatch a custom event carrying the Ray, which will be used by our `getFacadesAtEvent`
      // override to search for a hovered facade
      const e = new (eventParams.type === 'wheel' ? WheelEvent : MouseEvent)(eventParams.type, eventParams)
      e.isRayEvent = true
      e.ray = eventParams.ray
      this._onPointerActionEvent(e)
    }
  }
)


export default World3DFacade